import * as SecureStore from 'expo-secure-store';

export const SESSION_COOKIE_KEY = 'matrix.control-plane.session-cookie';

export interface ControlPlaneSession {
  /** Opaque HttpOnly-style control-plane session cookie, never a Matrix token. */
  cookie: string;
}

export interface SecureStoreAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface SessionStore {
  load(): Promise<ControlPlaneSession | null>;
  save(session: ControlPlaneSession): Promise<void>;
  clear(): Promise<void>;
}

export function createSessionStore(
  secureStore: SecureStoreAdapter = SecureStore,
): SessionStore {
  return {
    async load() {
      const cookie = await secureStore.getItemAsync(SESSION_COOKIE_KEY);
      return cookie ? { cookie } : null;
    },
    async save(session) {
      if (!session.cookie.trim()) {
        throw new Error('The control-plane session reference is empty');
      }
      await secureStore.setItemAsync(SESSION_COOKIE_KEY, session.cookie);
    },
    async clear() {
      await secureStore.deleteItemAsync(SESSION_COOKIE_KEY);
    },
  };
}

export const sessionStore = createSessionStore();
