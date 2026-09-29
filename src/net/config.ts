// How the online game connects. The Firebase web config comes from .env.local (see .env.example) or, when
// the site is served by Firebase Hosting, from the config Hosting publishes at /__/firebase/init.json.
// Without either, or with ?net=local in the address, online play runs on a local stand-in that syncs the
// tabs of this browser only (good for trying it out, useless across devices).

import { browserNetwork, LocalDb } from './db';
import type { Db } from './db';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  appId: string;
}

const env = import.meta.env;

const envConfig: FirebaseConfig | null = env.VITE_FIREBASE_API_KEY
  ? {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      databaseURL: env.VITE_FIREBASE_DATABASE_URL,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    }
  : null;

let resolved: FirebaseConfig | null = null;
let loading: Promise<FirebaseConfig | null> | null = null;

/** Finds the Firebase config (once). Call before firebaseConfig() or useLocalNet(). */
export function loadFirebaseConfig(): Promise<FirebaseConfig | null> {
  loading ??= (async () => {
    if (envConfig) return (resolved = envConfig);
    try {
      const res = await fetch('/__/firebase/init.json');
      const json = res.ok ? ((await res.json()) as Partial<FirebaseConfig>) : null; // a dev server answers with a page: not JSON
      if (json?.apiKey && json.databaseURL) resolved = json as FirebaseConfig;
    } catch {
      // Not on Firebase Hosting.
    }
    return resolved;
  })();
  return loading;
}

/** The Firebase config found by loadFirebaseConfig, if any. */
export const firebaseConfig = (): FirebaseConfig | null => resolved;

/** Local stand-in: forced with ?net=local, or used when Firebase is not configured. */
export const useLocalNet = (): boolean => new URLSearchParams(location.search).get('net') === 'local' || !resolved;

let pending: Promise<Db> | null = null;

/** The database connection for this tab (made once). */
export function openDb(): Promise<Db> {
  pending ??= loadFirebaseConfig().then(() => (useLocalNet() ? localDb() : import('./firebaseDb').then((m) => m.connectFirebase(resolved!))));
  return pending;
}

function localDb(): Db {
  // One id per tab, kept across reloads (like Firebase with session persistence).
  let uid = sessionStorage.getItem('net-uid');
  if (!uid) {
    uid = 'local-' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('net-uid', uid);
  }
  const { store, hub } = browserNetwork();
  return new LocalDb(uid, store, hub);
}
