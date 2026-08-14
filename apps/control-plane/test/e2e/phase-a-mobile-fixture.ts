import { getAdminPool, runMigrations } from '../../src/db/client';

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

export async function resetPhaseAMobileDatabase(): Promise<void> {
  await runMigrations();
  await getAdminPool().query('TRUNCATE rooms, users CASCADE');
}

export async function seedPhaseAMobileSpecialists(workspaceId: string): Promise<void> {
  const pool = getAdminPool();
  for (const profile of specialistFixtures) {
    await pool.query(
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
