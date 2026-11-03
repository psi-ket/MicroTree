/** Storage helpers that never throw (private mode, disabled storage). */

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const local = {
  get: (key: string) => safe(() => localStorage.getItem(key), null),
  set: (key: string, value: string) => safe(() => localStorage.setItem(key, value), undefined),
  remove: (key: string) => safe(() => localStorage.removeItem(key), undefined),
};

export const session = {
  get: (key: string) => safe(() => sessionStorage.getItem(key), null),
  set: (key: string, value: string) => safe(() => sessionStorage.setItem(key, value), undefined),
  remove: (key: string) => safe(() => sessionStorage.removeItem(key), undefined),
};

export const KEYS = {
  runtimeUrl: 'rs.runtimeUrl',
  pairingToken: 'rs.pairingToken',
  sessionToken: 'rs.sessionToken',
  theme: 'rs.theme',
  layout: 'rs.layout',
} as const;
