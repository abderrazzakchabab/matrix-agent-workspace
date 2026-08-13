import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({}));

import { createSessionStore, SESSION_COOKIE_KEY } from '../../src/auth/session-store';

class MemorySecureStore {
  readonly values = new Map<string, string>();

  async getItemAsync(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItemAsync(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async deleteItemAsync(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe('control-plane session store', () => {
  it('persists only the opaque control-plane cookie reference', async () => {
    const secureStore = new MemorySecureStore();
    const sessionStore = createSessionStore(secureStore);

    await sessionStore.save({ cookie: 'matrix_session=opaque-session' });

    expect(await sessionStore.load()).toEqual({ cookie: 'matrix_session=opaque-session' });
    expect([...secureStore.values.entries()]).toEqual([
      [SESSION_COOKIE_KEY, 'matrix_session=opaque-session'],
    ]);
    expect(await secureStore.getItemAsync('matrixAccessToken')).toBeNull();
  });

  it('clears the opaque session reference', async () => {
    const secureStore = new MemorySecureStore();
    const sessionStore = createSessionStore(secureStore);
    await sessionStore.save({ cookie: 'matrix_session=opaque-session' });

    await sessionStore.clear();

    expect(await sessionStore.load()).toBeNull();
  });
});
