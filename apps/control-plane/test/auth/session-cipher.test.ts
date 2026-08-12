import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFixtureTokenCipher } from '../../src/auth/matrix-token';
import {
  createSession,
  getSessionByOpaqueId,
  getTokenCipher,
  upsertMatrixUser,
} from '../../src/auth/session-service';
import { getAdminPool, runMigrations } from '../../src/db/client';

const HOMESERVER = 'http://localhost:8008';

async function resetDatabase(): Promise<void> {
  await getAdminPool().query(
    'TRUNCATE room_bindings, workspace_members, sessions, rooms, workspaces, users CASCADE',
  );
}

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
});

describe('production session cipher (AES-256-GCM envelope)', () => {
  it('default cipher seals plaintext into a non-fixture AES envelope', async () => {
    const cipher = getTokenCipher();
    const plaintext = 'syt_production_secret';
    const sealed = await cipher.encrypt(plaintext);

    // The fixture cipher marks every token with a literal "fixture" auth tag
    // and stores base64url plaintext; the production cipher must not.
    expect(sealed.authTag).not.toBe('fixture');
    expect(sealed.keyVersion).not.toBe('fixture');
    expect(sealed.iv).toHaveLength(16); // 12-byte GCM nonce, base64
    expect(sealed.authTag).toHaveLength(24); // 16-byte GCM tag, base64
    expect(sealed.ciphertext).not.toBe(Buffer.from(plaintext, 'utf8').toString('base64url'));
    expect(sealed.ciphertext).not.toContain(plaintext);
    expect(await cipher.decrypt(sealed)).toBe(plaintext);
  });

  it('createSession persists an AES envelope, never fixture material', async () => {
    const userId = await upsertMatrixUser('@alice:example.test', HOMESERVER);
    const plaintext = 'syt_session_token_at_rest';
    const { opaqueId } = await createSession(
      userId,
      plaintext,
      new Date(Date.now() + 3_600_000),
    );

    const { rows } = await getAdminPool().query(
      `SELECT matrix_access_token_ciphertext AS ciphertext,
              matrix_access_token_iv AS iv,
              matrix_access_token_auth_tag AS auth_tag,
              token_key_version AS key_version
         FROM sessions`,
    );
    const row = rows[0];
    expect(row).toBeTruthy();
    expect(row.auth_tag).not.toBe('fixture');
    expect(row.key_version).not.toBe('fixture');
    expect(row.iv).toHaveLength(16);
    expect(row.auth_tag).toHaveLength(24);
    expect(row.ciphertext).not.toBe(Buffer.from(plaintext, 'utf8').toString('base64url'));
    expect(row.ciphertext).not.toContain(plaintext);

    // The stored envelope decrypts back through the default cipher.
    const session = await getSessionByOpaqueId(opaqueId);
    expect(session.accessToken).toBe(plaintext);
  });
});

describe('fixture cipher stays available for explicit test injection', () => {
  it('still round-trips fixture envelopes', async () => {
    const cipher = createFixtureTokenCipher();
    const sealed = await cipher.encrypt('syt_legacy');
    expect(sealed.authTag).toBe('fixture');
    expect(sealed.keyVersion).toBe('fixture');
    expect(await cipher.decrypt(sealed)).toBe('syt_legacy');
  });

  it('createSession accepts an injected fixture cipher and reads it back', async () => {
    const userId = await upsertMatrixUser('@bob:example.test', HOMESERVER);
    const fixture = createFixtureTokenCipher();
    const plaintext = 'syt_fixture_token';
    const { opaqueId } = await createSession(
      userId,
      plaintext,
      new Date(Date.now() + 3_600_000),
      fixture,
    );

    const { rows } = await getAdminPool().query(
      `SELECT matrix_access_token_auth_tag AS auth_tag FROM sessions`,
    );
    expect(rows[0].auth_tag).toBe('fixture');

    const session = await getSessionByOpaqueId(opaqueId, fixture);
    expect(session.accessToken).toBe(plaintext);
  });
});
