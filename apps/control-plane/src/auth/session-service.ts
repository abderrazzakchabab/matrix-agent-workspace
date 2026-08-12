import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getPool, withTenant } from '../db/client';
import { SESSIONS } from '../db/schema/sessions';
import { createFixtureTokenCipher, type TokenCipher } from './matrix-token';

export const SESSION_COOKIE = 'matrix_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionContext {
  /** Opaque session id carried in the cookie; never stored in the database. */
  sessionId: string;
  /** Internal `users.id`. */
  userId: string;
  matrixUserId: string;
  homeserverUrl: string;
  /** Decrypted Synapse access token, held only in process memory. */
  accessToken: string;
  expiresAt: string;
}

export function hashSessionId(opaqueId: string): string {
  return createHash('sha256').update(opaqueId).digest('hex');
}

function generateOpaqueId(): string {
  return randomBytes(32).toString('base64url');
}

let defaultCipher: TokenCipher | undefined;

export function getTokenCipher(): TokenCipher {
  if (!defaultCipher) defaultCipher = createFixtureTokenCipher();
  return defaultCipher;
}

/** Create the `users` row for a verified Matrix identity (idempotent). */
export async function upsertMatrixUser(
  matrixUserId: string,
  homeserverUrl: string,
): Promise<string> {
  const { rows } = await getPool().query('SELECT upsert_matrix_user($1, $2) AS id', [
    matrixUserId,
    homeserverUrl,
  ]);
  return rows[0].id as string;
}

export interface NewSession {
  opaqueId: string;
  sessionId: string;
}

/** Create an opaque session whose id is stored only as a SHA-256 hash. */
export async function createSession(
  userId: string,
  matrixAccessToken: string,
  expiresAt: Date,
  cipher: TokenCipher = getTokenCipher(),
): Promise<NewSession> {
  const opaqueId = generateOpaqueId();
  const hash = hashSessionId(opaqueId);
  const encrypted = await cipher.encrypt(matrixAccessToken);
  const sessionId = randomUUID();
  await withTenant(userId, async (client) => {
    await client.query(
      `INSERT INTO ${SESSIONS.table}
         (${SESSIONS.id}, ${SESSIONS.sessionIdHash}, ${SESSIONS.userId},
          ${SESSIONS.ciphertext}, ${SESSIONS.iv}, ${SESSIONS.authTag},
          ${SESSIONS.keyVersion}, ${SESSIONS.expiresAt})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        hash,
        userId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.keyVersion,
        expiresAt,
      ],
    );
  });
  return { opaqueId, sessionId };
}

/** Resolve an opaque session id to its authenticated context. */
export async function getSessionByOpaqueId(
  opaqueId: string,
  cipher: TokenCipher = getTokenCipher(),
): Promise<SessionContext> {
  const hash = hashSessionId(opaqueId);
  const { rows } = await getPool().query('SELECT * FROM lookup_session($1)', [hash]);
  const row = rows[0];
  if (!row) throw new Error('session not found');
  if (row.revoked_at) throw new Error('session revoked');
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error('session expired');
  const accessToken = await cipher.decrypt({
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    keyVersion: row.key_version,
  });
  return {
    sessionId: opaqueId,
    userId: row.user_id,
    matrixUserId: row.matrix_user_id,
    homeserverUrl: row.homeserver_url,
    accessToken,
    expiresAt: row.expires_at,
  };
}

/** Revoke a session by its opaque id. */
export async function revokeSession(opaqueId: string): Promise<void> {
  const hash = hashSessionId(opaqueId);
  const { rows } = await getPool().query('SELECT * FROM lookup_session($1)', [hash]);
  const row = rows[0];
  if (!row) return;
  await withTenant(row.user_id as string, async (client) => {
    await client.query(
      `UPDATE ${SESSIONS.table} SET ${SESSIONS.revokedAt} = now() WHERE ${SESSIONS.sessionIdHash} = $1`,
      [hash],
    );
  });
}
