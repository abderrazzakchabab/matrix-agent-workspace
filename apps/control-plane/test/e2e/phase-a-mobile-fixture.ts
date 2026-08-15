import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes } from 'node:crypto';
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

// ── Phase C (Task 12) seeding helpers ───────────────────────────────────────
// Local AES-256-GCM envelope encryption matching src/security/envelope-encryption.ts
// (the control-plane module is not importable from the mobile typecheck
// program, so the fixture keeps a small typed copy for seeding only).

function envelopeKeyFromEnv(): { version: string; key: Buffer } {
  const raw: string = process.env.ENVELOPE_KEY_HEX ?? '';
  const current: string = process.env.ENVELOPE_KEY_VERSION ?? '';
  const entries = raw
    .split(',')
    .map((entry: string) => entry.trim())
    .filter((entry: string) => entry.length > 0)
    .map((entry: string) => {
      const colon = entry.indexOf(':');
      return colon === -1
        ? { version: current || '1', key: Buffer.from(entry, 'hex') }
        : { version: entry.slice(0, colon), key: Buffer.from(entry.slice(colon + 1), 'hex') };
    });
  const active = entries.find((entry) => entry.version === current) ?? entries.at(-1);
  if (!active || active.key.length !== 32) {
    throw new Error('Phase C seeding requires a 32-byte ENVELOPE_KEY_HEX entry');
  }
  return active;
}

function encryptFixtureToken(plaintext: string): {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
} {
  const { version, key } = envelopeKeyFromEnv();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: version,
  };
}

/** Seed the write-enabled fixture installation for `acme/widget` (id 42). */
export async function seedPhaseCGithubInstallation(workspaceId: string): Promise<void> {
  const encrypted = encryptFixtureToken('ghs_fixture_read_token');
  await adminPool.query(
    `INSERT INTO github_installations
       (id, workspace_id, installation_id, owner, repository_allowlist,
        token_ciphertext, token_iv, token_auth_tag, token_key_version, expires_at)
     VALUES ('ghi_phase_c', $1, '42', 'acme', '["acme/widget"]'::jsonb,
             $2, $3, $4, $5, '2035-01-01T00:00:00Z')`,
    [workspaceId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion],
  );
}

/** Approve a pending write grant (workspace administration outside the UI). */
export async function approvePhaseCWriteGrant(
  workspaceId: string,
  repository: string,
  scope: string,
): Promise<number> {
  const result = await adminPool.query(
    `UPDATE github_write_grants
        SET status = 'approved', approved_at = now(),
            expires_at = now() + interval '1 day', updated_at = now()
      WHERE workspace_id = $1 AND repository = $2 AND scope = $3`,
    [workspaceId, repository, scope],
  );
  return result.rowCount ?? 0;
}
