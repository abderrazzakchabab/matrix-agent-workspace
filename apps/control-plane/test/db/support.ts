import { randomUUID } from 'node:crypto';
import { getPool, getAdminPool, runMigrations, withTenant } from '../../src/db/client';

export { getPool, getAdminPool, runMigrations, withTenant };

/** Apply migrations, then truncate every table so each test file starts clean. */
export async function setupDb(): Promise<void> {
  await runMigrations();
  await resetAllTables();
}

/** Truncate all identity + Task 3 tables (CASCADE clears dependent rows). */
export async function resetAllTables(): Promise<void> {
  await getAdminPool().query(
    `TRUNCATE
       run_specialists, run_events, workflow_checkpoints, outbox_messages,
       agent_memories, github_links, github_installations, specialist_agents,
       runs,
       room_bindings, workspace_members, sessions, rooms, workspaces, users
     CASCADE`,
  );
}

/** Create a `users` row for a verified Matrix identity (idempotent). */
export async function createUser(
  matrixUserId: string,
  homeserverUrl = 'https://example.test',
): Promise<string> {
  const { rows } = await getPool().query('SELECT upsert_matrix_user($1, $2) AS id', [
    matrixUserId,
    homeserverUrl,
  ]);
  return rows[0].id as string;
}

/** Create a workspace owned by `ownerId` (adds the owner as a member). */
export async function createWorkspace(ownerId: string, name: string): Promise<string> {
  const workspaceId = `ws_${randomUUID()}`;
  await getPool().query('SELECT create_workspace($1, $2, $3, $4)', [
    workspaceId,
    ownerId,
    name,
    '{}',
  ]);
  return workspaceId;
}

/** Deterministic 1536-dimension unit vector for pgvector tests. */
export function vec1536(seed: number): number[] {
  const out = new Array<number>(1536);
  for (let i = 0; i < 1536; i += 1) out[i] = ((i * seed) % 1000) / 1000;
  return out;
}
