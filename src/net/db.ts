// The slice of a realtime database the online game needs. Firebase Realtime Database implements it for real
// (firebaseDb.ts); LocalDb implements it over a key-value store, for tests (a Map) and for trying online play
// without Firebase (localStorage, synced between the tabs of one browser).

export type Unsubscribe = () => void;

export interface Db {
  /** This connection's user id (Firebase anonymous auth, or a per-tab id locally). */
  readonly uid: string;
  /** "firebase" or "local": shown to the player so they know what they are connected to. */
  readonly kind: 'firebase' | 'local';
  get(path: string): Promise<unknown>;
  set(path: string, value: unknown): Promise<void>;
  /** Writes several children of `path` at once; keys may be nested paths ("views/p1/clock"). */
  update(path: string, values: Record<string, unknown>): Promise<void>;
  /** Adds a child with a new, chronologically ordered key and returns the key. */
  push(path: string, value: unknown): Promise<string>;
  remove(path: string): Promise<void>;
  /** Called with the current value (null if none), then again on every change. */
  onValue(path: string, cb: (value: unknown) => void): Unsubscribe;
  /** Called once per child, oldest key first: existing children, then each new one as it arrives. */
  onChildAdded(path: string, cb: (key: string, value: unknown) => void): Unsubscribe;
}

// ---- Local implementation -------------------------------------------------------------------

/** Where LocalDb keeps its data: one entry per leaf, keyed by its full path. */
export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(): string[];
}

/** Tells every LocalDb sharing a store (other tabs, other instances) which paths changed. */
export interface Hub {
  emit(paths: string[]): void;
  on(cb: (paths: string[]) => void): Unsubscribe;
}

const PREFIX = 'net:';
const clean = (path: string): string => path.split('/').filter(Boolean).join('/');
const join = (a: string, b: string): string => clean(`${a}/${b}`);
/** Is one path the other, or inside it? A change at either affects a listener at the other. */
const related = (a: string, b: string): boolean => a === b || a.startsWith(b + '/') || b.startsWith(a + '/') || a === '' || b === '';

let pushSeq = 0;
/** Push keys sort in creation order, like Firebase's: time first, then a counter, then randomness. */
export function pushKey(): string {
  pushSeq = (pushSeq + 1) % 1296;
  return Date.now().toString(36).padStart(9, '0') + pushSeq.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6);
}

export class LocalDb implements Db {
  readonly kind = 'local' as const;
  private listeners = new Set<{ path: string; fire: () => void }>();

  constructor(
    readonly uid: string,
    private store: KeyValue,
    private hub: Hub,
  ) {
    hub.on((paths) => this.dispatch(paths));
  }

  async get(path: string): Promise<unknown> {
    return this.read(clean(path));
  }

  async set(path: string, value: unknown): Promise<void> {
    const p = clean(path);
    this.write(p, value);
    this.hub.emit([p]);
  }

  async update(path: string, values: Record<string, unknown>): Promise<void> {
    const paths = Object.keys(values).map((k) => join(path, k));
    Object.entries(values).forEach(([k, v]) => this.write(join(path, k), v));
    this.hub.emit(paths);
  }

  async push(path: string, value: unknown): Promise<string> {
    const key = pushKey();
    await this.set(join(path, key), value);
    return key;
  }

  async remove(path: string): Promise<void> {
    await this.set(path, null);
  }

  onValue(path: string, cb: (value: unknown) => void): Unsubscribe {
    const p = clean(path);
    let last: string | undefined;
    const fire = (): void => {
      const v = this.read(p);
      const json = JSON.stringify(v);
      if (json === last) return;
      last = json;
      cb(v);
    };
    return this.listen(p, fire);
  }

  onChildAdded(path: string, cb: (key: string, value: unknown) => void): Unsubscribe {
    const p = clean(path);
    const seen = new Set<string>();
    const fire = (): void => {
      const v = this.read(p);
      const keys = v && typeof v === 'object' ? Object.keys(v).sort() : [];
      for (const k of keys) {
        if (seen.has(k)) continue;
        seen.add(k);
        cb(k, (v as Record<string, unknown>)[k]);
      }
      // A removed child can come back as a new one later.
      for (const k of [...seen]) if (!keys.includes(k)) seen.delete(k);
    };
    return this.listen(p, fire);
  }

  private listen(path: string, fire: () => void): Unsubscribe {
    const l = { path, fire };
    this.listeners.add(l);
    queueMicrotask(() => this.listeners.has(l) && fire()); // like Firebase: the first value arrives asynchronously
    return () => this.listeners.delete(l);
  }

  private dispatch(paths: string[]): void {
    for (const l of [...this.listeners]) if (paths.some((p) => related(p, l.path))) l.fire();
  }

  /** The value at `path`: a leaf, an object assembled from the leaves under it, or null. */
  private read(path: string): unknown {
    const own = this.store.get(PREFIX + path);
    if (own !== null) return JSON.parse(own);
    const base = PREFIX + (path ? path + '/' : '');
    let out: Record<string, unknown> | null = null;
    for (const key of this.store.keys()) {
      if (!key.startsWith(base)) continue;
      const parts = key.slice(base.length).split('/');
      out ??= {};
      let node = out;
      for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
      node[parts[parts.length - 1]] = JSON.parse(this.store.get(key)!);
    }
    return out;
  }

  /** Replaces whatever is at `path` (and under it) with `value`, stored leaf by leaf. Null deletes. */
  private write(path: string, value: unknown): void {
    const base = PREFIX + path;
    for (const key of this.store.keys()) if (key === base || key.startsWith(base + '/')) this.store.delete(key);
    // A value written under an existing leaf replaces that leaf, as in Firebase.
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.store.delete(PREFIX + parts.slice(0, i).join('/'));
    const put = (p: string, v: unknown): void => {
      if (v === null || v === undefined) return;
      if (typeof v === 'object') {
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) put(`${p}/${k}`, child);
        return;
      }
      this.store.set(PREFIX + p, JSON.stringify(v));
    };
    put(path, value);
  }
}

/** A store and hub kept in memory: every LocalDb made from one of these sees the others' writes (tests). */
export function memoryNetwork(): { store: KeyValue; hub: Hub } {
  const map = new Map<string, string>();
  const subs = new Set<(paths: string[]) => void>();
  return {
    store: {
      get: (k) => map.get(k) ?? null,
      set: (k, v) => void map.set(k, v),
      delete: (k) => void map.delete(k),
      keys: () => [...map.keys()],
    },
    hub: {
      emit: (paths) => subs.forEach((cb) => cb(paths)),
      on: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    },
  };
}

/**
 * localStorage shared by every tab of this browser on this site. Other tabs hear about changes through the
 * "storage" event, which only fires once the change is visible to them (a separate message could arrive
 * first and read stale data). Events come one per key, so they are gathered and dispatched together.
 */
export function browserNetwork(): { store: KeyValue; hub: Hub } {
  const subs = new Set<(paths: string[]) => void>();
  let pending: string[] = [];
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !e.key.startsWith(PREFIX)) return;
    if (!pending.length) {
      setTimeout(() => {
        const paths = pending;
        pending = [];
        subs.forEach((cb) => cb(paths));
      }, 0);
    }
    pending.push(e.key === null ? '' : e.key.slice(PREFIX.length)); // null: storage was cleared
  });
  return {
    store: {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
      delete: (k) => localStorage.removeItem(k),
      keys: () => Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)),
    },
    hub: {
      emit: (paths) => subs.forEach((cb) => cb(paths)), // this tab; the others get "storage" events
      on: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    },
  };
}
