// IO glue: credentials, cached data, refresh policy.
import * as db from './db.js';
import { fetchUser, fetchDailies, rateBlockedUntil } from './api.js';
import { slimTask, ingest, buildView, mergeObserved } from './model.js';

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

export async function testCreds(creds) {
  return fetchUser(creds);
}

let lastRequest = 0;
let inflight = null;

/** Fetch from Habitica (2 requests), persist, and return the fresh view. */
export function refresh(creds, { force = false } = {}) {
  if (inflight) return inflight;
  const now = Date.now();
  if (!force && now - lastRequest < MIN_MANUAL_GAP_MS) return Promise.resolve(null);
  if (rateBlockedUntil() > now) return Promise.reject(Object.assign(new Error('Rate limited — try again shortly.'), { retryAt: rateBlockedUntil() }));
  lastRequest = now;
  inflight = (async () => {
    const [user, dailies] = await Promise.all([fetchUser(creds), fetchDailies(creds)]);
    const data = {
      fetchedAt: Date.now(),
      user: { lastCron: user.lastCron, needsCron: user.needsCron, preferences: user.preferences, name: user.profile?.name },
      dailies: dailies.map(slimTask),
    };
    const { snapshots, observed } = ingest(data.user, data.dailies, await db.getAll('observed'));
    await db.putMany('snapshots', snapshots);
    await db.putMany('observed', observed);
    await db.kvSet('data', data);
    return loadView();
  })().finally(() => { inflight = null; });
  return inflight;
}

export async function exportBackup() {
  return db.exportAll();
}

export async function importBackup(json) {
  return db.importAll(json, mergeObserved);
}

export async function wipeLocalData() {
  await db.clearAll();
}

export async function requestPersistence() {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
