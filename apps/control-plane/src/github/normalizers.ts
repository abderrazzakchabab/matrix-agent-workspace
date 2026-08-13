export interface NormalizedRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  htmlUrl: string;
  archived: boolean;
}

export interface NormalizedIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  author: string | null;
  labels: string[];
  body: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedPullRequest {
  id: number;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string | null;
  head: string;
  base: string;
  body: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedPullRequestFile {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface NormalizedPullRequestReview {
  id: number;
  state: string;
  author: string | null;
  body: string | null;
  submittedAt: string | null;
  htmlUrl: string;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null ? (value as JsonObject) : {};
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function login(value: unknown): string | null {
  const candidate = string(object(value).login);
  return candidate || null;
}

export function normalizeRepository(value: unknown): NormalizedRepository {
  const raw = object(value);
  return {
    id: number(raw.id),
    name: string(raw.name),
    fullName: string(raw.full_name),
    owner: login(raw.owner) ?? '',
    private: raw.private === true,
    defaultBranch: string(raw.default_branch),
    description: nullableString(raw.description),
    htmlUrl: string(raw.html_url),
    archived: raw.archived === true,
  };
}

export function normalizeIssue(value: unknown): NormalizedIssue {
  const raw = object(value);
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((label) => (typeof label === 'string' ? label : string(object(label).name)))
        .filter(Boolean)
    : [];
  return {
    id: number(raw.id),
    number: number(raw.number),
    title: string(raw.title),
    state: string(raw.state).toLowerCase(),
    author: login(raw.user),
    labels,
    body: nullableString(raw.body),
    htmlUrl: string(raw.html_url),
    createdAt: string(raw.created_at),
    updatedAt: string(raw.updated_at),
  };
}

export function normalizePullRequest(value: unknown): NormalizedPullRequest {
  const raw = object(value);
  return {
    id: number(raw.id),
    number: number(raw.number),
    title: string(raw.title),
    state: string(raw.state).toLowerCase(),
    draft: raw.draft === true,
    author: login(raw.user),
    head: string(object(raw.head).ref),
    base: string(object(raw.base).ref),
    body: nullableString(raw.body),
    htmlUrl: string(raw.html_url),
    createdAt: string(raw.created_at),
    updatedAt: string(raw.updated_at),
  };
}

export function normalizePullRequestFile(value: unknown): NormalizedPullRequestFile {
  const raw = object(value);
  const normalized: NormalizedPullRequestFile = {
    sha: string(raw.sha),
    filename: string(raw.filename),
    status: string(raw.status).toLowerCase(),
    additions: number(raw.additions),
    deletions: number(raw.deletions),
    changes: number(raw.changes),
  };
  if (typeof raw.patch === 'string') normalized.patch = raw.patch;
  return normalized;
}

export function normalizePullRequestReview(value: unknown): NormalizedPullRequestReview {
  const raw = object(value);
  return {
    id: number(raw.id),
    state: string(raw.state).toLowerCase(),
    author: login(raw.user),
    body: nullableString(raw.body),
    submittedAt: nullableString(raw.submitted_at),
    htmlUrl: string(raw.html_url),
  };
}
