/**
 * Matrix delivery client and encrypted token service.
 *
 * `SynapseDeliveryClient` sends room messages through the Client-Server API,
 * using the outbox delivery key as the Matrix transaction id so a retried send
 * is deduplicated by the homeserver. The token service resolves a user's
 * encrypted session token from persistence (AES-256-GCM envelope cipher) and
 * never leaves plaintext in any serialized output.
 */
import type { PoolClient } from 'pg';
import { getSynapseBaseUrl } from '../auth/matrix-token';
import { getTokenCipher } from '../auth/session-service';

export interface MatrixSendParams {
  accessToken: string;
  homeserverUrl: string;
  roomId: string;
  body: string;
  /** Stable delivery key used as the Matrix transaction id. */
  deliveryKey: string;
}

export interface MatrixSendResult {
  eventId: string;
}

export interface MatrixDeliveryClient {
  sendMessage(params: MatrixSendParams): Promise<MatrixSendResult>;
}

/** A Matrix send failure with a status code and whether it is retryable. */
export class MatrixSendError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'MatrixSendError';
    this.status = status;
    this.retryable = retryable;
  }
}

export class MatrixTokenUnavailableError extends Error {
  readonly code = 'MATRIX_TOKEN_UNAVAILABLE';
  constructor() {
    super('No active Matrix session token is available for this user');
    this.name = 'MatrixTokenUnavailableError';
  }
}

/** Transient Matrix failures (5xx/429) are retried; 4xx are permanent. */
export function isRetryableMatrixError(error: unknown): boolean {
  return error instanceof MatrixSendError && error.retryable;
}

export function isMatrixTokenUnavailable(error: unknown): boolean {
  return error instanceof MatrixTokenUnavailableError;
}

/** Matrix Client-Server API send client (Synapse compatible). */
export class SynapseDeliveryClient implements MatrixDeliveryClient {
  constructor(private readonly baseUrl: string = getSynapseBaseUrl()) {}

  async sendMessage(params: MatrixSendParams): Promise<MatrixSendResult> {
    const txnId = encodeURIComponent(params.deliveryKey);
    const url = `${params.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(
      params.roomId,
    )}/send/m.room.message/${txnId}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ msgtype: 'm.text', body: params.body }),
    });
    if (res.status === 429 || res.status >= 500) {
      throw new MatrixSendError(`Matrix send failed with ${res.status}`, res.status, true);
    }
    if (!res.ok) {
      throw new MatrixSendError(`Matrix send failed with ${res.status}`, res.status, false);
    }
    const data = (await res.json()) as { event_id?: string };
    return { eventId: data.event_id ?? txnId };
  }
}

let defaultClient: MatrixDeliveryClient | undefined;

export function getMatrixDeliveryClient(): MatrixDeliveryClient {
  if (!defaultClient) defaultClient = new SynapseDeliveryClient();
  return defaultClient;
}

/**
 * Resolve the latest active session token for `userId` and decrypt it.
 * Must run inside a tenant transaction whose `app.user_id` is `userId` so the
 * sessions/user rows are visible under RLS.
 */
export async function resolveMatrixAccessToken(
  client: PoolClient,
  userId: string,
): Promise<{ accessToken: string; homeserverUrl: string; matrixUserId: string }> {
  const { rows } = await client.query(
    `SELECT s.matrix_access_token_ciphertext AS ciphertext,
            s.matrix_access_token_iv AS iv,
            s.matrix_access_token_auth_tag AS auth_tag,
            s.token_key_version AS key_version,
            u.homeserver_url AS homeserver_url,
            u.matrix_user_id AS matrix_user_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.user_id = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new MatrixTokenUnavailableError();
  const accessToken = await getTokenCipher().decrypt({
    ciphertext: row.ciphertext as string,
    iv: row.iv as string,
    authTag: row.auth_tag as string,
    keyVersion: row.key_version as string,
  });
  return {
    accessToken,
    homeserverUrl: row.homeserver_url as string,
    matrixUserId: row.matrix_user_id as string,
  };
}
