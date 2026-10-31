// Habitica API client. The browser calls Habitica directly (CORS is open).
const BASE = 'https://habitica.com/api/v3';
const BLOCK_KEY = 'sb.rateBlockedUntil';

export class ApiError extends Error {
  constructor(message, { status = 0, retryAt = 0 } = {}) {
    super(message);
    this.status = status;
    this.retryAt = retryAt;
  }
}

export function rateBlockedUntil() {
  return Number(localStorage.getItem(BLOCK_KEY) || 0);
}

function headers({ userId, apiToken }) {
  return {
    'x-api-user': userId,
    'x-api-key': apiToken,
    'x-client': `${userId}-HabiticaStreakDashboard`,
  };
}

/** Compute when we may call again from Retry-After (seconds) or X-RateLimit-Reset (date). */
function retryAtFrom(res) {
  const ra = res.headers.get('Retry-After');
  if (ra && !isNaN(Number(ra))) return Date.now() + Number(ra) * 1000;
  const reset = res.headers.get('X-RateLimit-Reset');
  const t = reset ? Date.parse(reset) : NaN;
  return isNaN(t) ? Date.now() + 60000 : t;
}

async function get(path, creds) {
  const blocked = rateBlockedUntil();
  if (blocked > Date.now()) {
    throw new ApiError('Rate limited by Habitica — waiting before retrying.', { status: 429, retryAt: blocked });
  }
  let res;
  try {
    res = await fetch(BASE + path, { headers: headers(creds), cache: 'no-store' });
  } catch {
    throw new ApiError('Network error — showing cached data.');
  }
  // Back off pre-emptively when we're about to exhaust the window.
  const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
  if (res.headers.has('X-RateLimit-Remaining') && remaining <= 2) {
    localStorage.setItem(BLOCK_KEY, String(retryAtFrom(res)));
  }
  if (res.status === 429) {
    const retryAt = retryAtFrom(res);
    localStorage.setItem(BLOCK_KEY, String(retryAt));
    throw new ApiError('Rate limited by Habitica — waiting before retrying.', { status: 429, retryAt });
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (res.status === 401) throw new ApiError('Habitica rejected the User ID / API token.', { status: 401 });
  if (!res.ok || !body?.success) {
    throw new ApiError(body?.message || `Habitica error (${res.status})`, { status: res.status });
  }
  return body.data;
}

export const fetchUser = (creds) =>
  get('/user?userFields=preferences.dayStart,preferences.timezoneOffset,preferences.sleep,profile.name,lastCron,needsCron', creds);

export const fetchDailies = (creds) => get('/tasks/user?type=dailys', creds);
