// Small UI helpers shared by views and the app controller.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function relTime(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const fmtDay = (key, opts = { month: 'short', day: 'numeric' }) =>
  new Date(key + 'T12:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });

export const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

export const FLAME = '<svg class="flame" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c.9 3.3-1.4 5.2-2.8 7.1C7.9 11.4 7.4 12.9 7.4 14.3c0 3.3 2.3 6.2 4.6 6.2s4.6-2.9 4.6-6.2c0-1.9-.9-3.3-1.8-4.3.2 1.4-.3 2.6-1.2 3.1.3-3.1-.6-6.8-1.6-10.6z"/></svg>';
export const REFRESH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4l-2.3 2.3z"/></svg>';
export const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>';
export const PLUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';

/** Show a toast; with `action` ({ label, run }) it gets a button, e.g. Undo. */
export function toast(msg, ms = 2800, action = null) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-btn';
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.run(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

/** Progress ring (SVG) for done/total. */
export function ring(done, total, size = 64) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const frac = total ? done / total : 0;
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg${frac >= 1 ? ' full' : ''}"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - frac)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
  </svg>`;
}
