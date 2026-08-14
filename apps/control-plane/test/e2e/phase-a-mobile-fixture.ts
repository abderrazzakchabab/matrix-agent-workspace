import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

const specialistFixtures = [
  {
    id: 'repo-reader',
    name: 'Repository Reader',
    policy: 'Read repository metadata only.',
    tools: ['read_repository'],
  },
  {
    id: 'issue-reader',
    name: 'Issue Reader',
    policy: 'Read GitHub issues only.',
    tools: ['read_issue'],
  },
  {
    id: 'pr-reader',
    name: 'Pull Request Reader',
    policy: 'Read pull requests only.',
    tools: ['read_pull_request'],
  },
] as const;

const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

export async function resetPhaseAMobileDatabase(): Promise<void> {
  const migrationsDirectory = join(
    process.cwd(),
    'apps/control-plane/src/db/migrations',
  );
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await adminPool.query(await readFile(join(migrationsDirectory, file), 'utf8'));
  }
  await adminPool.query('TRUNCATE rooms, users CASCADE');
}

export async function seedPhaseAMobileSpecialists(workspaceId: string): Promise<void> {
  for (const profile of specialistFixtures) {
    await adminPool.query(
      `INSERT INTO specialist_agents
         (id, workspace_id, name, model, gateway_provider, system_policy,
          tools_allowlist, timeout_ms, enabled)
       VALUES ($1, $2, $3, 'gpt-4o-mini', 'openai', $4, $5, 60000, true)`,
      [
        profile.id,
        workspaceId,
        profile.name,
        JSON.stringify({ systemPolicy: profile.policy }),
        JSON.stringify(profile.tools),
      ],
    );
  }
}

export async function closePhaseAMobileDatabase(): Promise<void> {
  await adminPool.end();
}
