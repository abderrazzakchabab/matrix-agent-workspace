/**
 * Matrix homeserver integration.
 *
 * All identity comes from the homeserver's `/whoami` response; the control
 * plane never trusts a client-supplied Matrix user ID. The configured Synapse
 * (SYNAPSE_BASE_URL) is the only homeserver the control plane talks to.
 */

export function getSynapseBaseUrl(): string {
  return process.env.SYNAPSE_BASE_URL ?? 'http://localhost:8008';
}

/**
 * Encrypted token envelope. Production encryption is AES-256-GCM via
 * `security/envelope-encryption.ts`; Task 2 auth still uses the fixture cipher.
 */
export interface EncryptedToken {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
}

export interface TokenCipher {
  encrypt(plaintext: string): Promise<EncryptedToken>;
  decrypt(token: EncryptedToken): Promise<string>;
}

/**
 * Task 2 fixture cipher. Reversible and non-cryptographic; still the default
 * session cipher. `security/envelope-encryption.ts` provides the production
 * AES-256-GCM cipher, which must replace this before deployment.
 */
export function createFixtureTokenCipher(): TokenCipher {
  return {
    async encrypt(plaintext: string): Promise<EncryptedToken> {
      return {
        ciphertext: Buffer.from(plaintext, 'utf8').toString('base64url'),
        iv: '',
        authTag: 'fixture',
        keyVersion: 'fixture',
      };
    },
    async decrypt(token: EncryptedToken): Promise<string> {
      if (token.authTag !== 'fixture' || token.keyVersion !== 'fixture') {
        throw new Error('FixtureTokenCipher cannot decrypt non-fixture tokens');
      }
      return Buffer.from(token.ciphertext, 'base64url').toString('utf8');
    },
  };
}

export class MatrixTokenInvalidError extends Error {
  readonly code = 'MATRIX_TOKEN_INVALID';
  readonly status = 401;
  constructor() {
    super('The provided Matrix access token is invalid');
  }
}

export class MatrixUnavailableError extends Error {
  readonly code = 'MATRIX_UNAVAILABLE';
  readonly status = 502;
  constructor() {
    super('The Matrix homeserver is unavailable');
  }
}

export class RoomMembershipRequiredError extends Error {
  readonly code = 'ROOM_MEMBERSHIP_REQUIRED';
  readonly status = 403;
  constructor() {
    super('Membership in the room is required');
  }
}

export interface MatrixHomeserverClient {
  whoami(accessToken: string): Promise<{ userId: string }>;
  joinedRooms(accessToken: string): Promise<string[]>;
  assertMembership(accessToken: string, roomId: string, userId: string): Promise<void>;
}

/** Client for the Synapse Client-Server API. */
export class SynapseClient implements MatrixHomeserverClient {
  constructor(private readonly baseUrl: string) {}

  async whoami(accessToken: string): Promise<{ userId: string }> {
    const res = await fetch(`${this.baseUrl}/_matrix/client/v3/account/whoami`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) throw new MatrixTokenInvalidError();
    if (!res.ok) throw new MatrixUnavailableError();
    const data = (await res.json()) as { user_id?: string };
    if (!data.user_id) throw new MatrixTokenInvalidError();
    return { userId: data.user_id };
  }

  async joinedRooms(accessToken: string): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/_matrix/client/v3/joined_rooms`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) throw new MatrixTokenInvalidError();
    if (!res.ok) throw new MatrixUnavailableError();
    const data = (await res.json()) as { joined_rooms?: string[] };
    return data.joined_rooms ?? [];
  }

  async assertMembership(accessToken: string, roomId: string, userId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (res.status === 401) throw new MatrixTokenInvalidError();
    if (res.status === 403 || res.status === 404) throw new RoomMembershipRequiredError();
    if (!res.ok) throw new MatrixUnavailableError();
    const data = (await res.json()) as { membership?: string };
    if (data.membership !== 'join') throw new RoomMembershipRequiredError();
  }
}

let matrixClient: MatrixHomeserverClient | undefined;

export function getMatrixClient(): MatrixHomeserverClient {
  if (!matrixClient) matrixClient = new SynapseClient(getSynapseBaseUrl());
  return matrixClient;
}
