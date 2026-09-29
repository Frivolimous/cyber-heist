// Firebase Realtime Database behind the Db interface, signed in anonymously. Loaded only for online play,
// so the offline sandbox never downloads the SDK.

import { initializeApp } from 'firebase/app';
import { browserSessionPersistence, getAuth, setPersistence, signInAnonymously } from 'firebase/auth';
import { getDatabase, get, onChildAdded, onValue, push, ref, remove, set, update } from 'firebase/database';
import type { Db, Unsubscribe } from './db';
import type { FirebaseConfig } from './config';

export async function connectFirebase(config: FirebaseConfig): Promise<Db> {
  const app = initializeApp(config);
  const auth = getAuth(app);
  // One identity per tab (it survives a reload): several tabs of one browser can be several players.
  await setPersistence(auth, browserSessionPersistence);
  const { user } = auth.currentUser ? { user: auth.currentUser } : await signInAnonymously(auth);
  const db = getDatabase(app);
  const at = (path: string) => ref(db, path);
  return {
    uid: user.uid,
    kind: 'firebase',
    get: async (path) => (await get(at(path))).val(),
    set: (path, value) => set(at(path), value ?? null),
    update: (path, values) => update(at(path), values),
    push: async (path, value) => (await push(at(path), value)).key!,
    remove: (path) => remove(at(path)),
    onValue: (path, cb): Unsubscribe => onValue(at(path), (snap) => cb(snap.val())),
    onChildAdded: (path, cb): Unsubscribe => onChildAdded(at(path), (snap) => cb(snap.key!, snap.val())),
  };
}
