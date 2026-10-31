// Tiny IndexedDB wrapper. Stores:
//   kv        — arbitrary key/value (cached API data)
//   snapshots — one row per task per Habitica day, as seen at fetch time
//   observed  — per-task record: max streak seen, breaks, accumulated day statuses
const DB_NAME = 'streakboard';
const VERSION = 1;
const STORES = ['kv', 'snapshots', 'observed'];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: ['taskId', 'day'] }).createIndex('taskId', 'taskId');
        }
        if (!db.objectStoreNames.contains('observed')) db.createObjectStore('observed', { keyPath: 'taskId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    Promise.resolve(fn(t.objectStore(store))).then((r) => (result = r), reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = (key) => tx('kv', 'readonly', (s) => promisify(s.get(key)));
export const kvSet = (key, val) => tx('kv', 'readwrite', (s) => { s.put(val, key); });

export const getAll = (store) => tx(store, 'readonly', (s) => promisify(s.getAll()));
export const putMany = (store, rows) => tx(store, 'readwrite', (s) => { rows.forEach((r) => s.put(r)); });

export async function exportAll() {
  const out = { app: 'streakboard', version: 1, exportedAt: new Date().toISOString() };
  for (const s of ['snapshots', 'observed']) out[s] = await getAll(s);
  return out;
}

/** Merge an export into the local DB. Observed records are combined, not replaced. */
export async function importAll(data, mergeObserved) {
  if (!data || data.app !== 'streakboard') throw new Error('Not a Streakboard backup file');
  const snaps = Array.isArray(data.snapshots) ? data.snapshots.filter((r) => r.taskId && r.day) : [];
  await putMany('snapshots', snaps);
  const existing = new Map((await getAll('observed')).map((o) => [o.taskId, o]));
  const merged = (data.observed || []).filter((o) => o.taskId).map((o) => mergeObserved(existing.get(o.taskId), o));
  await putMany('observed', merged);
  return { snapshots: snaps.length, tasks: merged.length };
}

export async function clearAll() {
  for (const s of STORES) await tx(s, 'readwrite', (st) => { st.clear(); });
}
