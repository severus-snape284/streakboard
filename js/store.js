// IO glue: credentials, cached data, refresh policy, writes with local patches.
import * as db from './db.js';
import * as api from './api.js';
import { slimTask, slimHabit, ingest, buildView, mergeObserved, timeCtx } from './model.js';

const CREDS_KEY = 'sb.creds';
export const AUTO_REFRESH_MS = 5 * 60 * 1000;
export const MIN_MANUAL_GAP_MS = 15 * 1000;

export function getCreds() {
  try {
    const c = JSON.parse(localStorage.getItem(CREDS_KEY));
    return c?.userId && c?.apiToken ? c : null;
  } catch { return null; }
}
export function setCreds(c) { localStorage.setItem(CREDS_KEY, JSON.stringify(c)); }
export function clearCreds() { localStorage.removeItem(CREDS_KEY); }

export async function loadView() {
  const [data, snaps, observed] = await Promise.all([db.kvGet('data'), db.getAll('snapshots'), db.getAll('observed')]);
  return buildView(data, snaps, observed);
}

export const testCreds = (creds) => api.fetchUser(creds);

let lastRequest = 0;
let inflight = null;

/** Fetch from Habitica (3 requests), persist, and return { view, celebrations }. */
export function refresh(creds, { force = false } = {}) {
  if (inflight) return inflight;
  const now = Date.now();
  if (!force && now - lastRequest < MIN_MANUAL_GAP_MS) return Promise.resolve(null);
  if (api.rateBlockedUntil() > now) {
    return Promise.reject(Object.assign(new Error('Rate limited — try again shortly.'), { retryAt: api.rateBlockedUntil() }));
  }
  lastRequest = now;
  inflight = (async () => {
    const [user, dailies, habits] = await Promise.all([api.fetchUser(creds), api.fetchDailies(creds), api.fetchHabits(creds)]);
    const data = {
      fetchedAt: Date.now(),
      user: { lastCron: user.lastCron, needsCron: user.needsCron, preferences: user.preferences, name: user.profile?.name },
      dailies: dailies.map(slimTask),
      habits: habits.filter((h) => h.up).map(slimHabit),
    };
    const { snapshots, observed, celebrations } = ingest(data.user, data.dailies, await db.getAll('observed'));
    await db.putMany('snapshots', snapshots);
    await db.putMany('observed', observed);
    await db.kvSet('data', data);
    return { view: await loadView(), celebrations };
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Apply a local patch to a cached daily/habit (optimistic UI) and return the new view. */
export async function patchLocal(kind, id, fn) {
  const data = await db.kvGet('data');
  if (!data) return null;
  const list = kind === 'habit' ? data.habits : data.dailies;
  const item = list?.find((x) => x.id === id);
  if (!item) return null;
  fn(item, data);
  await db.kvSet('data', data);
  if (kind === 'daily') {
    const { cronDay } = timeCtx(data.user);
    await db.putMany('snapshots', [{ taskId: id, day: cronDay, completed: !!item.completed, isDue: !!item.isDue, streak: item.streak, ts: Date.now() }]);
  }
  return loadView();
}

export const scoreTask = (creds, id, dir) => api.scoreTask(creds, id, dir);
export const scoreChecklistItem = (creds, taskId, itemId) => api.scoreChecklistItem(creds, taskId, itemId);
export const runCron = (creds) => api.runCron(creds);

export const exportBackup = () => db.exportAll();
export const importBackup = (json) => db.importAll(json, mergeObserved);
export const wipeLocalData = () => db.clearAll();

export async function requestPersistence() {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
