// Dependency-free SVG charts. Single-series by design (no legend; the title names it).
// Marks follow fixed specs: columns ≤ 24px with a 4px rounded top on one baseline,
// 2px lines with a 10% area wash, hairline gridlines, and a tap/hover tooltip via [data-tip].
import { esc, fmtDay } from './ui.js';

const W = 340;
const PAD = { l: 30, r: 10, t: 12, b: 22 };

const roundedTop = (x, y, w, h, r = 4) => {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

function table(caption, head, rows) {
  return `<details class="chart-table"><summary>Show data</summary><table><caption class="sr">${esc(caption)}</caption>
    <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

/** Weekly completion columns: [{ from, done, due, rate, current }]. */
export function weeklyColumns(weeks, { title = 'Weekly completion', height = 150 } = {}) {
  const H = height, pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
  const band = pw / weeks.length;
  const bw = Math.min(24, band * 0.62);
  const y = (r) => PAD.t + ph * (1 - r);
  let grid = '';
  for (const g of [0, 0.5, 1]) {
    grid += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(g)}" y2="${y(g)}" class="grid"/>
      <text x="${PAD.l - 6}" y="${y(g) + 3.5}" class="tick" text-anchor="end">${g * 100}%</text>`;
  }
  let marks = '', labels = '';
  weeks.forEach((w, i) => {
    const cx = PAD.l + band * i + band / 2;
    const tip = `Week of ${fmtDay(w.from)}${w.current ? ' (so far)' : ''}: ${w.due ? `${w.done}/${w.due} done · ${Math.round(w.rate * 100)}%` : 'no due days'}`;
    if (w.rate != null) {
      const h = Math.max(2, ph * w.rate);
      marks += `<path d="${roundedTop(cx - bw / 2, y(0) - h, bw, h)}" class="col${w.current ? ' current' : ''}"/>`;
    } else {
      marks += `<line x1="${cx - 3}" x2="${cx + 3}" y1="${y(0) - 1}" y2="${y(0) - 1}" class="nodata"/>`;
    }
    marks += `<rect x="${cx - band / 2}" y="${PAD.t}" width="${band}" height="${ph + 6}" class="hit" data-tip="${esc(tip)}" data-x="${cx}"/>`;
    if (i % 3 === 0 || i === weeks.length - 1) labels += `<text x="${cx}" y="${H - 6}" class="tick" text-anchor="middle">${esc(fmtDay(w.from))}</text>`;
  });
  const last = [...weeks].reverse().find((w) => w.rate != null);
  return `<figure class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}${last ? `, latest ${Math.round(last.rate * 100)}%` : ''}">
      ${grid}${marks}<line class="xhair" y1="${PAD.t}" y2="${y(0)}" x1="0" x2="0" visibility="hidden"/>${labels}
    </svg>
    ${table(title, ['Week of', 'Done', 'Due', 'Rate'], weeks.map((w) => [fmtDay(w.from), w.done, w.due, w.rate == null ? '—' : `${Math.round(w.rate * 100)}%`]))}
  </figure>`;
}

/** Streak length over time: [{ day, streak }]. */
export function streakLine(series, { title = 'Streak over time', height = 150 } = {}) {
  if (series.length < 2) return '';
  const H = height, pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
  const max = Math.max(3, ...series.map((p) => p.streak));
  const step = max <= 5 ? 1 : max <= 12 ? 2 : max <= 30 ? 5 : max <= 60 ? 10 : 20;
  const top = Math.ceil(max / step) * step;
  const x = (i) => PAD.l + (pw * i) / (series.length - 1);
  const y = (v) => PAD.t + ph * (1 - v / top);
  let grid = '';
  for (const g of [0, top / 2, top]) {
    grid += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(g)}" y2="${y(g)}" class="grid"/>
      <text x="${PAD.l - 6}" y="${y(g) + 3.5}" class="tick" text-anchor="end">${Math.round(g)}</text>`;
  }
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.streak).toFixed(1)}`);
  const area = `M${x(0)},${y(0)}L${pts.join('L')}L${x(series.length - 1)},${y(0)}Z`;
  const lastP = series[series.length - 1];
  const band = pw / (series.length - 1);
  const hits = series.map((p, i) => `<rect x="${x(i) - band / 2}" y="${PAD.t}" width="${band}" height="${ph + 6}" class="hit"
      data-tip="${esc(`${fmtDay(p.day)}: ${p.streak}-day streak`)}" data-x="${x(i)}" data-y="${y(p.streak)}"/>`).join('');
  const peak = series.reduce((a, b) => (b.streak > a.streak ? b : a));
  const pi = series.indexOf(peak);
  const labels = [0, Math.floor((series.length - 1) / 2), series.length - 1]
    .map((i, j) => `<text x="${x(i)}" y="${H - 6}" class="tick" text-anchor="${['start', 'middle', 'end'][j]}">${esc(fmtDay(series[i].day))}</text>`).join('');
  return `<figure class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: now ${lastP.streak}, peak ${peak.streak}">
      ${grid}
      <path d="${area}" class="area"/>
      <polyline points="${pts.join(' ')}" class="line"/>
      ${peak.streak > lastP.streak ? `<text x="${Math.min(Math.max(x(pi), PAD.l + 12), W - PAD.r - 12)}" y="${y(peak.streak) - 7}" class="peak" text-anchor="middle">${peak.streak}</text>` : ''}
      <circle cx="${x(series.length - 1)}" cy="${y(lastP.streak)}" r="5" class="end"/>
      <line class="xhair" y1="${PAD.t}" y2="${y(0)}" x1="0" x2="0" visibility="hidden"/>
      <circle class="xdot" r="5" cx="0" cy="0" visibility="hidden"/>
      ${labels}${hits}
    </svg>
    ${table(title, ['Day', 'Streak'], series.filter((_, i) => i % 7 === (series.length - 1) % 7).map((p) => [fmtDay(p.day), p.streak]))}
  </figure>`;
}

/** Tiny 12-week sparkline of completion rate; current week highlighted. */
export function sparkColumns(weeks) {
  const w = 72, h = 22, band = w / weeks.length, bw = Math.max(2, band - 2);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${weeks.map((wk, i) => {
    if (wk.rate == null) return `<rect x="${i * band}" y="${h - 1}" width="${bw}" height="1" class="nodata"/>`;
    const bh = Math.max(2, h * wk.rate);
    return `<path d="${roundedTop(i * band, h - bh, bw, bh, 1.5)}" class="${i === weeks.length - 1 ? 'col current-strong' : 'col soft'}"/>`;
  }).join('')}</svg>`;
}

/** Wire tap/hover tooltips for every chart inside `root` (call once). */
export function initChartTooltips(root) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  document.body.append(tip);
  let hideT;
  const show = (el, ev) => {
    const svg = el.closest('svg');
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${svg.getBoundingClientRect().top + window.scrollY - tip.offsetHeight - 6}px`;
    const xh = svg.querySelector('.xhair');
    if (xh) { xh.setAttribute('x1', el.dataset.x); xh.setAttribute('x2', el.dataset.x); xh.setAttribute('visibility', 'visible'); }
    const xd = svg.querySelector('.xdot');
    if (xd && el.dataset.y) { xd.setAttribute('cx', el.dataset.x); xd.setAttribute('cy', el.dataset.y); xd.setAttribute('visibility', 'visible'); }
    clearTimeout(hideT);
    if (ev.pointerType === 'touch') hideT = setTimeout(hide, 2500);
  };
  const hide = () => {
    tip.hidden = true;
    root.querySelectorAll('.xhair, .xdot').forEach((m) => m.setAttribute('visibility', 'hidden'));
  };
  root.addEventListener('pointerover', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) show(el, e); });
  root.addEventListener('pointerdown', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) show(el, e); else hide(); });
  root.addEventListener('pointerout', (e) => { if (e.pointerType === 'mouse' && e.target.closest?.('[data-tip]')) hide(); });
  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('hashchange', hide);
}
