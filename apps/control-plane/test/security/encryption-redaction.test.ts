import { describe, it, expect } from 'vitest';
import {
  EnvelopeCipher,
  type EnvelopeKeyring,
  type EnvelopeKey,
} from '../../src/security/envelope-encryption';
import { redact, safeStringify } from '../../src/security/redaction';

function twoVersionKeyring(): EnvelopeKeyring {
  const keys: EnvelopeKey[] = [
    { version: 'v1', key: Buffer.alloc(32, 0x01) },
    { version: 'v2', key: Buffer.alloc(32, 0x02) },
  ];
  return {
    currentVersion: 'v2',
    getKey: (version: string) => keys.find((k) => k.version === version),
  };
}

describe('envelope encryption (AES-256-GCM)', () => {
  it('round-trips with a key version and never stores plaintext', async () => {
    const cipher = new EnvelopeCipher(twoVersionKeyring());
    const sealed = await cipher.encrypt('syt_secret');
    expect(sealed.keyVersion).toBe('v2');
    expect(sealed.ciphertext).not.toContain('syt_secret');
    expect(sealed.iv).toHaveLength(16); // 12 bytes -> base64
    expect(sealed.authTag).toHaveLength(24); // 16 bytes -> base64
    expect(await cipher.decrypt(sealed)).toBe('syt_secret');
  });

  it('uses a fresh IV per encryption (non-deterministic ciphertext)', async () => {
    const cipher = new EnvelopeCipher(twoVersionKeyring());
    const a = await cipher.encrypt('same-plaintext');
    const b = await cipher.encrypt('same-plaintext');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects tampered ciphertext and auth tags', async () => {
    const cipher = new EnvelopeCipher(twoVersionKeyring());
    const sealed = await cipher.encrypt('syt_secret');
    const tamperedTag = {
      ...sealed,
      authTag: Buffer.alloc(16, 0xff).toString('base64'),
    };
    await expect(cipher.decrypt(tamperedTag)).rejects.toThrow();
    await expect(cipher.decrypt({ ...sealed, ciphertext: 'AAAA' })).rejects.toThrow();
    await expect(cipher.decrypt({ ...sealed, iv: Buffer.alloc(12, 0x99).toString('base64') })).rejects.toThrow();
  });

  it('decrypts old key versions and re-encrypts on access', async () => {
    const cipher = new EnvelopeCipher(twoVersionKeyring());
    const old = await cipher.encrypt('legacy_secret', 'v1');
    expect(old.keyVersion).toBe('v1');
    const { plaintext, envelope } = await cipher.decryptAndReencrypt(old);
    expect(plaintext).toBe('legacy_secret');
    expect(envelope.keyVersion).toBe('v2');
    expect(await cipher.decrypt(envelope)).toBe('legacy_secret');
  });

  it('does not re-encrypt when already on the current version', async () => {
    const cipher = new EnvelopeCipher(twoVersionKeyring());
    const sealed = await cipher.encrypt('syt_secret');
    const { envelope } = await cipher.decryptAndReencrypt(sealed);
    expect(envelope).toBe(sealed);
  });

  it('rejects unknown key versions', async () => {
    const cipher = new EnvelopeCipher(twoVersionKeyring());
    await expect(
      cipher.decrypt({ ciphertext: 'x', iv: 'y', authTag: 'z', keyVersion: 'v99' }),
    ).rejects.toThrow(/unknown envelope key version/i);
  });

  it('never serializes plaintext credentials', async () => {
    const cipher = new EnvelopeCipher(twoVersionKeyring());
    const sealed = await cipher.encrypt('ghp_supersecretvalue');
    const json = JSON.stringify(sealed);
    expect(json).not.toContain('ghp_supersecretvalue');
    expect(json).not.toContain('supersecret');
  });
});

describe('structured redaction', () => {
  it('redacts authorization headers', () => {
    expect(redact({ authorization: 'Bearer ghp_secret' }).authorization).toBe('[REDACTED]');
    expect(redact({ authorization: 'Basic dXNlcjpwYXNzd29yZA==' }).authorization).toBe('[REDACTED]');
    expect(redact({ Authorization: 'Bearer syt_secret' }).Authorization).toBe('[REDACTED]');
  });

  it('redacts Matrix, GitHub, and provider token-shaped values', () => {
    expect(redact({ token: 'syt_abcdef123' }).token).toBe('[REDACTED]');
    expect(redact({ accessToken: 'ghp_abcdef123456' }).accessToken).toBe('[REDACTED]');
    expect(redact({ apiKey: 'sk-abcdefghijklmnop' }).apiKey).toBe('[REDACTED]');
    expect(redact({ clientSecret: 'github_pat_abcdef123' }).clientSecret).toBe('[REDACTED]');
  });

  it('redacts OAuth codes', () => {
    expect(redact({ code: '0123456789abcdef0123456789abcdef' }).code).toBe('[REDACTED]');
  });

  it('redacts deeply nested structures and arrays', () => {
    const out = redact({
      user: { matrixToken: 'syt_xyz' },
      headers: { Authorization: 'Bearer ghp_abc12345' },
      list: ['syt_secret', 'plain text'],
      nested: [{ secret: 'sk-abcdefghijklmnop' }, { ok: true }],
    });
    expect(out).toEqual({
      user: { matrixToken: '[REDACTED]' },
      headers: { Authorization: '[REDACTED]' },
      list: ['[REDACTED]', 'plain text'],
      nested: [{ secret: '[REDACTED]' }, { ok: true }],
    });
  });

  it('redacts inline token-shaped values inside log messages', () => {
    expect(redact('sent syt_secret123 to room')).toBe('sent [REDACTED] to room');
    expect(redact('Authorization: Bearer ghp_abc12345 was used')).toBe(
      'Authorization: [REDACTED] was used',
    );
  });

  it('leaves non-secret values intact', () => {
    expect(redact({ message: 'run completed', count: 3, status: 'queued' })).toEqual({
      message: 'run completed',
      count: 3,
      status: 'queued',
    });
  });

  it('safeStringify never leaks plaintext', () => {
    const json = safeStringify({
      token: 'syt_secret',
      msg: 'Bearer ghp_abc12345 rejected',
      nested: { apiKey: 'sk-abcdefghijklmnop' },
    });
    expect(json).not.toContain('syt_secret');
    expect(json).not.toContain('ghp_abc12345');
    expect(json).not.toContain('sk-abcdefghijklmnop');
    expect(json).toContain('[REDACTED]');
  });
});
