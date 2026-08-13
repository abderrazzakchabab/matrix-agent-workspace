import {
  normalizeIssue,
  normalizePullRequest,
  normalizePullRequestFile,
  normalizePullRequestReview,
  normalizeRepository,
  type NormalizedIssue,
  type NormalizedPullRequest,
  type NormalizedPullRequestFile,
  type NormalizedPullRequestReview,
  type NormalizedRepository,
} from './normalizers';

export interface CursorOptions {
  cursor?: string;
  perPage?: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface GithubReadClient {
  listRepositories(input: {
    installationId: string;
    cursor?: string;
    perPage?: number;
  }): Promise<CursorPage<NormalizedRepository>>;
  listIssues(
    owner: string,
    repo: string,
    options?: CursorOptions,
  ): Promise<CursorPage<NormalizedIssue>>;
  listPullRequests(
    owner: string,
    repo: string,
    options?: CursorOptions,
  ): Promise<CursorPage<NormalizedPullRequest>>;
  listPullRequestFiles(
    owner: string,
    repo: string,
    pullNumber: number,
    options?: CursorOptions,
  ): Promise<CursorPage<NormalizedPullRequestFile>>;
  listPullRequestReviews(
    owner: string,
    repo: string,
    pullNumber: number,
    options?: CursorOptions,
  ): Promise<CursorPage<NormalizedPullRequestReview>>;
}

export class GithubCursorError extends Error {
  readonly code = 'GITHUB_CURSOR_INVALID';
  readonly status = 422;
  constructor() {
    super('Invalid GitHub pagination cursor');
    this.name = 'GithubCursorError';
  }
}

export class GithubReadError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number) {
    super(status === 404 ? 'GitHub resource not found' : 'GitHub read request failed');
    this.name = 'GithubReadError';
    this.status = status === 401 || status === 403 || status === 404 ? status : 502;
    this.code = status === 404 ? 'GITHUB_RESOURCE_NOT_FOUND' : 'GITHUB_READ_FAILED';
  }
}

export interface GithubFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type GithubFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<GithubFetchResponse>;

export interface GithubReadClientOptions {
  token: string | (() => Promise<string>);
  baseUrl?: string;
  fetch?: GithubFetch;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function validateName(value: string): string {
  if (!NAME_PATTERN.test(value)) throw new GithubReadError(404);
  return value;
}

function pageFromCursor(cursor?: string): number {
  if (cursor === undefined) return 1;
  const match = /^p([1-9][0-9]*)$/.exec(cursor);
  if (!match) throw new GithubCursorError();
  const page = Number(match[1]);
  if (!Number.isSafeInteger(page)) throw new GithubCursorError();
  return page;
}

function perPage(value?: number): number {
  if (value === undefined) return 30;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new GithubCursorError();
  return value;
}

function nextCursor(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    if (!/;\s*rel="next"\s*$/.test(part.trim())) continue;
    const match = /<([^>]+)>/.exec(part);
    if (!match) return undefined;
    try {
      const page = Number(new URL(match[1]!).searchParams.get('page'));
      if (Number.isSafeInteger(page) && page > 0) return `p${page}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function createGithubReadClient(options: GithubReadClientOptions): GithubReadClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(
    /\/$/,
    '',
  );

  async function request(path: string, cursor?: string, requestedPerPage?: number) {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set('page', String(pageFromCursor(cursor)));
    url.searchParams.set('per_page', String(perPage(requestedPerPage)));
    const token = typeof options.token === 'string' ? options.token : await options.token();
    let response: GithubFetchResponse;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'matrix-agent-workspace-control-plane',
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'error',
      });
    } catch {
      throw new GithubReadError(502);
    }
    if (!response.ok) throw new GithubReadError(response.status);
    try {
      return {
        data: await response.json(),
        nextCursor: nextCursor(response.headers.get('link')),
      };
    } catch {
      throw new GithubReadError(502);
    }
  }

  async function arrayPage<T>(
    path: string,
    options: CursorOptions | undefined,
    normalize: (value: unknown) => T,
  ): Promise<CursorPage<T>> {
    const response = await request(path, options?.cursor, options?.perPage);
    return {
      items: asArray(response.data).map(normalize),
      ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    };
  }

  const client: GithubReadClient = {
    async listRepositories(input) {
      if (!input.installationId) throw new GithubReadError(404);
      const response = await request('/installation/repositories', input.cursor, input.perPage);
      const raw = response.data as { repositories?: unknown };
      return {
        items: asArray(raw?.repositories).map(normalizeRepository),
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
      };
    },

    async listIssues(owner, repo, listOptions) {
      const path = `/repos/${encodeURIComponent(validateName(owner))}/${encodeURIComponent(validateName(repo))}/issues`;
      const response = await request(path, listOptions?.cursor, listOptions?.perPage);
      const items = asArray(response.data)
        .filter((item) => !('pull_request' in (item as Record<string, unknown>)))
        .map(normalizeIssue);
      return {
        items,
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
      };
    },

    async listPullRequests(owner, repo, listOptions) {
      return arrayPage(
        `/repos/${encodeURIComponent(validateName(owner))}/${encodeURIComponent(validateName(repo))}/pulls`,
        listOptions,
        normalizePullRequest,
      );
    },

    async listPullRequestFiles(owner, repo, pullNumber, listOptions) {
      if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new GithubReadError(404);
      return arrayPage(
        `/repos/${encodeURIComponent(validateName(owner))}/${encodeURIComponent(validateName(repo))}/pulls/${pullNumber}/files`,
        listOptions,
        normalizePullRequestFile,
      );
    },

    async listPullRequestReviews(owner, repo, pullNumber, listOptions) {
      if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new GithubReadError(404);
      return arrayPage(
        `/repos/${encodeURIComponent(validateName(owner))}/${encodeURIComponent(validateName(repo))}/pulls/${pullNumber}/reviews`,
        listOptions,
        normalizePullRequestReview,
      );
    },
  };
  return Object.freeze(client);
}
