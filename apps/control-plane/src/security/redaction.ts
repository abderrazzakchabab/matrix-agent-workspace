/**
 * Structured redaction for logs, errors, traces, audit records, and Matrix
 * messages. Secret-shaped values are replaced with `[REDACTED]`; plaintext
 * tokens, authorization headers, OAuth codes, and secret-shaped strings never
 * reach serialized output.
 */

export const REDACTED = '[REDACTED]';

/** Keys whose values are always redacted regardless of shape. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'accesstoken',
  'refreshtoken',
  'token',
  'apikey',
  'secret',
  'clientsecret',
  'password',
  'privatekey',
  'code',
  'oauthcode',
  'session',
  'cookie',
  'set-cookie',
  'setcookie',
  'matrixtoken',
  'matrixaccesstoken',
  'githubtoken',
  'providertoken',
  'x-api-key',
  'xapikey',
  'credential',
  'credentials',
]);

/** Token-shaped prefixes for well-known secret providers. */
const INLINE_PATTERNS: RegExp[] = [
  // Authorization headers first, so "Bearer ghp_..." is replaced as one unit.
  /\bBearer\s+[A-Za-z0-9._~+/-]{4,}=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}\b/gi,
  // Provider tokens.
  /\bsyt_[A-Za-z0-9_-]+/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_-]+/g,
  /\bsk-ant-[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]+/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  // PEM private-key blocks.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
];

/** Replace secret-shaped substrings inside free text with `[REDACTED]`. */
export function redactText(text: string): string {
  let out = text;
  for (const pattern of INLINE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Recursively redact a value: object keys in {@link SENSITIVE_KEYS} are always
 * replaced, and secret-shaped substrings are scrubbed from any string value.
 * The value's structural type is preserved (string values remain strings).
 */
export function redact<T>(value: T, key?: string): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEYS.has(key.toLowerCase())) return REDACTED as T;
    return redactText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redact(childValue, childKey);
    }
    return out as unknown as T;
  }
  return value;
}

/** JSON-serialize a value with all secrets redacted. */
export function safeStringify<T>(value: T): string {
  return JSON.stringify(redact(value));
}
