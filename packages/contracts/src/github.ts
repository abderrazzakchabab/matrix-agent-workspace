import { z } from 'zod';

/** Query for listing GitHub App installations' repositories (Phase B read-only). */
export const ListRepositoriesQuery = z.object({
  installationId: z.string().min(1),
  cursor: z.string().optional(),
});

export type ListRepositoriesQueryType = z.infer<typeof ListRepositoriesQuery>;

/** Query for listing issues in a repository (Phase B read-only). */
export const ListIssuesQuery = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  cursor: z.string().optional(),
});

export type ListIssuesQueryType = z.infer<typeof ListIssuesQuery>;

/** Query for listing pull requests in a repository (Phase B read-only). */
export const ListPullRequestsQuery = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  cursor: z.string().optional(),
});

export type ListPullRequestsQueryType = z.infer<typeof ListPullRequestsQuery>;

/** Discriminated union of all Phase B read-only GitHub queries. */
export const GithubReadQuery = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list_repositories'), ...ListRepositoriesQuery.shape }),
  z.object({ kind: z.literal('list_issues'), ...ListIssuesQuery.shape }),
  z.object({ kind: z.literal('list_pull_requests'), ...ListPullRequestsQuery.shape }),
]);

export type GithubReadQueryType = z.infer<typeof GithubReadQuery>;
