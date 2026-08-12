import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope encryption with key versioning.
 *
 * The database only ever stores `{ ciphertext, iv, authTag, keyVersion }`;
 * plaintext exists only in process memory. Rotating to a new key version makes
 * old ciphertext decryptable via the previous version's key and re-encrypted
 * with the current version on access (`decryptAndReencrypt`).
 */

export interface EncryptedEnvelope {
  /** Base64 ciphertext. */
  ciphertext: string;
  /** Base64 12-byte nonce. */
  iv: string;
  /** Base64 16-byte GCM authentication tag. */
  authTag: string;
  /** Version of the key that produced this envelope. */
  keyVersion: string;
}

export interface EnvelopeKey {
  version: string;
  /** Exactly 32 bytes for AES-256. */
  key: Buffer;
}

export interface EnvelopeKeyring {
  /** Version used for new encryptions. */
  currentVersion: string;
  /** Resolve the key for a version, or `undefined` when retired/unknown. */
  getKey(version: string): EnvelopeKey | undefined;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class EnvelopeCipher {
  constructor(private readonly keyring: EnvelopeKeyring) {}

  async encrypt(plaintext: string, version?: string): Promise<EncryptedEnvelope> {
    const keyVersion = version ?? this.keyring.currentVersion;
    const key = this.keyring.getKey(keyVersion);
    if (!key) throw new Error(`Unknown envelope key version: ${keyVersion}`);
    if (key.key.length !== KEY_LENGTH) {
      throw new Error(`Envelope key "${keyVersion}" must be ${KEY_LENGTH} bytes (AES-256)`);
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion,
    };
  }

  /** Decrypt and authenticate; throws on tampering or unknown key versions. */
  async decrypt(envelope: EncryptedEnvelope): Promise<string> {
    const key = this.keyring.getKey(envelope.keyVersion);
    if (!key) throw new Error(`Unknown envelope key version: ${envelope.keyVersion}`);
    const decipher = createDecipheriv(ALGORITHM, key.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(), // throws when the auth tag does not match (tampering)
    ]);
    return plaintext.toString('utf8');
  }

  /**
   * Decrypt, then re-encrypt with the current key version when the envelope is
   * on an older version. Returns the plaintext alongside the (possibly new)
   * envelope the caller should persist.
   */
  async decryptAndReencrypt(
    envelope: EncryptedEnvelope,
  ): Promise<{ plaintext: string; envelope: EncryptedEnvelope }> {
    const plaintext = await this.decrypt(envelope);
    if (envelope.keyVersion === this.keyring.currentVersion) {
      return { plaintext, envelope };
    }
    return { plaintext, envelope: await this.encrypt(plaintext) };
  }
}

function hexToBuffer(hex: string): Buffer {
  const normalized = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('Envelope key must be hex-encoded bytes');
  }
  return Buffer.from(normalized, 'hex');
}

/**
 * Build a keyring from the environment.
 *
 * `ENVELOPE_KEY_HEX` is a comma-separated list of `version:hex` entries; a bare
 * hex value uses `ENVELOPE_KEY_VERSION` (default `1`) as its version. The
 * current version is `ENVELOPE_KEY_VERSION` when set, otherwise the last key.
 */
export function createKeyringFromEnv(): EnvelopeKeyring {
  const raw = process.env.ENVELOPE_KEY_HEX ?? '';
  const keys: EnvelopeKey[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const colon = entry.indexOf(':');
    if (colon === -1) {
      keys.push({
        version: process.env.ENVELOPE_KEY_VERSION ?? '1',
        key: hexToBuffer(entry),
      });
    } else {
      keys.push({ version: entry.slice(0, colon), key: hexToBuffer(entry.slice(colon + 1)) });
    }
  }
  if (keys.length === 0) {
    throw new Error('No envelope keys configured: set ENVELOPE_KEY_HEX');
  }
  const byVersion = new Map(keys.map((k) => [k.version, k]));
  const currentVersion =
    process.env.ENVELOPE_KEY_VERSION ?? keys[keys.length - 1]!.version;
  return {
    currentVersion,
    getKey: (version) => byVersion.get(version),
  };
}

let defaultCipher: EnvelopeCipher | undefined;

/** Process-wide default cipher backed by `ENVELOPE_KEY_HEX`. */
export function getDefaultEnvelopeCipher(): EnvelopeCipher {
  if (!defaultCipher) defaultCipher = new EnvelopeCipher(createKeyringFromEnv());
  return defaultCipher;
}

export async function encrypt(plaintext: string, version?: string): Promise<EncryptedEnvelope> {
  return getDefaultEnvelopeCipher().encrypt(plaintext, version);
}

export async function decrypt(envelope: EncryptedEnvelope): Promise<string> {
  return getDefaultEnvelopeCipher().decrypt(envelope);
}
