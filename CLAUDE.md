# Streakboard — handoff for Claude sessions

This file is the briefing for any Claude session working in this repo. A previous
session gathered requirements and made decisions with the owner; nothing has been
built yet. Read all of it before starting.

## Status

- **Phase 0 done, v1 through v3.1 built and live (2026-10-31):** https://severus-snape284.github.io/streakboard/
- v2 + consistency extras shipped (owner asked for "all additions that help me be consistent"): tick
  dailies/checklists with optimistic UI, streak rescue + `POST /cron`, countdown/progress ring,
  don't-miss-twice, perfect days, Insights tab, Habits tab, milestone celebrations, app badge.
  Web Push reminders were skipped: they need a push server.
- v2.1 (owner: "start on the next improvements"): usual time per daily (median check-off time,
  late ticks excluded) + Time sort + "usually done by" flag; when/where plan per daily; miss-reason
  tagging + Insights card; habit goals (streak = periods meeting goal); milestone forecast from
  `nextDue`; overall consistency calendar. User-entered data lives in IndexedDB kv `prefs`
  ({cues, reasons, targets}), is exported/imported, and survives "Delete local streak history".
- Pages is enabled and deploying (owner set Source = GitHub Actions).
- v2.2: widget for the Scriptable app (`widgets/streakboard-widget.js`, Keychain creds, offline cache,
  tested via a stubbed Scriptable API in `tests/widget.test.mjs`; PWAs can't have native widgets);
  undo toast after ticking; 2-minute version per daily (`prefs.minis`); weekly review + focus daily
  (`prefs.focus = {taskId, since}`, lasts 7 days). The SW only serves the app shell for app routes, not file URLs.
- v2.3: smart reminders in the widget (Scriptable local notifications, rescheduled on each refresh, only
  while dailies are due); Rest in the Inn toggle (`POST /user/sleep`; verified in cron.js that sleep skips
  streak resets and damage but still writes history). Inn days are detected as due+unticked cron entries
  whose value didn't drop → status 'rest' (neutral). "Needs adjustment" tips; tomorrow preview.
- v2.4 (owner wants "complete sync with Habitica"): refresh on every resume (visibilitychange/pageshow/focus)
  if data > 20s old, and every 2 min while visible. Habit "this period" uses Habitica's `counterUp`.
  Habit + button turns green ✓ with count once the goal is met (still tappable). New logo: `tools/icon.svg`
  rendered by `tools/render_icons.mjs` (flame inside a progress ring); `tools/make_icons.py` removed.
- v3.0 (owner: single-daily widget, trends, "best possible UI"): full CSS rewrite (tokens, large titles,
  grouped To do/Done/Not today lists, 7-day dots per row, merged "Needs attention" card, check pop animation);
  `js/charts.js` = dependency-free SVG charts following the dataviz skill specs (single series, ≤24px columns,
  2px line + 10% area, hairline grid, tap tooltips, "Show data" tables); trends in detail + Insights.
  Widget parameter = a daily's name → single-daily widget; widget embeds a copy of the history logic,
  kept equal to the app's by `tests/widget.test.mjs`.
- v3.1 (owner has an iPhone 17 Pro; asked for Siri + Apple Intelligence): the Scriptable script doubles as a
  Shortcuts/Siri endpoint (`args.shortcutParameter`): `briefing`, `week`, `tomorrow`, `tick <name>` (dailies, then
  positive habits; POST score/up), `ask <question>` (returns a compact grounded prompt for the Shortcuts
  "Use Model" action). Setup steps live in Settings → Siri & Apple Intelligence (Shortcuts can't be imported
  unsigned, so the owner builds them by hand). Claude-API coach was offered but not chosen (paid service).
- Verified in Habitica source (`website/server/libs/cron.js`, `common/script/ops/scoreTask.js`):
  GET requests do NOT run cron (only `POST /cron`); score up = streak+1 + history push;
  score down = streak−1 + removes last history entry.
- Layout: `index.html`, `sw.js`, `manifest.webmanifest`, `css/app.css`, `js/` (`streaks.js`,
  `model.js`, `insights.js` = pure logic; `api.js`, `db.js`, `store.js` = IO; `views.js`, `ui.js`,
  `app.js` = UI), `icons/`
  (from `tools/icon.svg` via `tools/render_icons.mjs`), `tests/` (`npm test` unit, `npm run e2e` Playwright w/ mocked API).
- Bump `VERSION` in `sw.js` on each release.
- Owner decisions already made (do not re-ask):
  - Repo is **public**; host on **GitHub Pages**, deployed by a GitHub Actions workflow.
  - **Push directly to `main`.** No PR needed.
  - Owner agreed to all "Changes from the original spec" listed below.
- Credentials are in the cloud environment as secrets/env vars:
  `HABITICA_USER_ID` and `HABITICA_API_TOKEN`. Read them from the environment only.
  **Never print them, log them, write them to any file, or commit them.**
  The token has full account access: during exploration make **GET requests only**.

## What we are building

A personal, mobile-first PWA showing the owner's Habitica streaks, streak-first.
One user (the owner). Installed on iPhone via Safari → Share → Add to Home Screen
(iOS 16.4+). The owner keeps using the official Habitica app for check-ins.

## Verified facts (checked 2026-10-31)

- **CORS is open — no proxy needed.** An OPTIONS preflight to
  `https://habitica.com/api/v3/tasks/user` from a third-party origin returned:
  - `access-control-allow-origin: *`
  - `access-control-allow-methods: OPTIONS,GET,POST,PUT,HEAD,DELETE`
  - `access-control-allow-headers: ...,x-api-user,x-api-key,x-client`
  - `access-control-expose-headers: X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,Retry-After`
  So the browser can call Habitica directly and read rate-limit headers.
  A proxy would add no security for a single-user app (the device must hold the
  token either way), so don't build one. Document this in the README.
- Habitica is reachable from the cloud container (`GET /api/v3/status` → 200).

## Phase 0 findings (2026-10-31, real account)

- Dailies have `streak`, `completed`, `isDue`, `nextDue`, `frequency`, `everyX`, `repeat`,
  `daysOfMonth`, `weeksOfMonth`, `startDate`, `checklist`, `history`, `yesterDaily`.
- Daily `history` entries are `{date, value, isDue, completed}`, back to task creation (~70 days seen).
  **Not one entry per day.** Semantics (verified; reconstruction matches actual `streak` for all dailies):
  - each check-off writes `completed:true` at check-off time;
  - cron writes `completed:false` (+`isDue`) **only for dailies not completed**;
  - a cron entry closes the previous *active* day (any activity triggers cron);
  - check-offs before that day's cron ("record yesterday's activity") belong to the previous active day.
  Implemented in `js/streaks.js` (`analyzeHistory`, `historyToDays`).
- Habits: `up`, `down`, `counterUp`, `counterDown`, `frequency`, history `{date, value, scoredUp, scoredDown}`.
- User: `preferences.dayStart` (5), `preferences.timezoneOffset` (-330), `lastCron` present;
  `needsCron` absent → staleness is computed from `lastCron` vs today. `userFields` with dotted
  paths doesn't actually filter (harmless).
- Rate-limit headers: limit 30, `X-RateLimit-Reset` is a date string.

## Phase 0 — verify real data before building (done)

Using the env-var credentials, GET-only:

- `GET /api/v3/user` (consider `?userFields=preferences,stats,profile,lastCron,needsCron` to keep it small)
- `GET /api/v3/tasks/user?type=dailys`
- `GET /api/v3/tasks/user?type=habits`

Headers: `x-api-user: $HABITICA_USER_ID`, `x-api-key: $HABITICA_API_TOKEN`,
`x-client: $HABITICA_USER_ID-HabiticaStreakDashboard`.

Save raw responses only in the scratchpad (never the repo). Inspect and then
**summarize findings to the owner before building**, specifically:

1. Daily fields actually present: `streak`, `completed`, `isDue`, `nextDue`,
   `frequency`/`everyX`/`repeat`/`daysOfMonth`/`weeksOfMonth`, `startDate`, `checklist`.
2. Daily `history` entry shape — expected `{date, value, isDue?, completed?}`.
   Confirm whether `completed`/`isDue` exist and how far back history goes.
   This decides (a) the heatmap source and (b) whether past longest streaks can be backfilled.
3. Habit fields: `counterUp`, `counterDown`, `frequency`, `history` shape.
4. User: `preferences.dayStart`, `preferences.timezoneOffset`, `lastCron`, `needsCron`.

If any assumption below turns out wrong, adapt and tell the owner.

## Agreed technical approach

- **No build step, zero runtime dependencies.** Vanilla JS ES modules + HTML + CSS,
  served as static files. (Owner must approve any dependency that needs a build
  server or paid service.)
- **Direct browser → Habitica API calls.** Credentials entered on a Settings screen on
  first launch, stored only on the device (localStorage is fine for creds).
  "Log out / clear credentials" button. Nothing hardcoded anywhere.
- **Due-today:** use Habitica's server-computed `isDue` / `completed` rather than
  re-implementing schedule logic. Caveat: streaks/`isDue` update only after Habitica's
  cron runs (often when the owner next opens the official app). Detect stale cron
  (`needsCron` / `lastCron` vs today given `dayStart` + timezone) and show a subtle note.
- **Longest streak:** primary source = reconstruct from each daily's `history`
  (if it has completion info) so "best" includes the past; also store per-fetch
  snapshots `{taskId, date, streak}` and keep `longestStreak = max(observed, reconstructed)`.
  Record streak breaks (current resets to 0).
- **Storage:** IndexedDB for snapshots/history; call `navigator.storage.persist()`.
  Export/Import JSON backup button.
- **Heatmap:** from Habitica `history` if it has completion info, else local snapshots.
- **Rate limit (~30 req/min):** fetch on app open, on pull-to-refresh, and at most every
  few minutes otherwise. Batch, cache, handle 429 using `Retry-After` /
  `X-RateLimit-Reset`. Never poll aggressively.
- **Service worker:** cache the app shell (opens instantly, works offline); show last
  fetched data with a "last updated" timestamp. Version the cache so updates roll out.
- **Deploy:** GitHub Pages via a GitHub Actions workflow on push to `main`.
  The site will be served from a subpath (`/streakboard/`), so use relative URLs
  everywhere (manifest `start_url`/`scope`, SW registration, icons).
  The owner may need to set Settings → Pages → Source = "GitHub Actions" once;
  tell them if the deploy fails for that reason.
- **Testing on the phone:** via the deployed Pages URL (no same-Wi-Fi dev server from
  the cloud). Locally, verify with a static server + Playwright (Chromium is
  preinstalled; use an iPhone-sized viewport) before pushing.

## Feature spec

### v1 (build first, end to end)

1. **Home: streak-first list of dailies.** Sort toggle: by streak (default, desc) /
   by due today / by name. Each row: title, big prominent streak number with a flame
   icon, status (done today / due / not due today), and "current / best".
2. **Hero section:** single best current streak, number of active streaks
   (streak > 0), number of dailies still due today.
3. **"Streak at risk" banner:** dailies with streak ≥ 3, due today, not completed.
4. **Longest-streak tracking** (see approach above), with break history.
5. **Detail view** (tap a row): calendar heatmap + streak stats for that task.
6. **Milestones:** subtle celebration styling at 7, 21, 30, 66, 100, 365 days.
7. **Pull-to-refresh**, loading and error states, "last updated" timestamp.

### v2 (after v1 works)

- Tap a daily to complete it (`POST /tasks/:id/score/up`) with optimistic UI and
  rollback on failure; confirm before un-completing (`score/down`).
- Positive habits shown with their counter streaks.
- Weekly summary: completion rate per daily over last 7 / 30 days.
- Web Push reminders: skip unless trivially easy.

## iOS / PWA requirements

- `viewport-fit=cover`, safe-area insets (`env(safe-area-inset-*)`),
  `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
  `apple-touch-icon` (180), `manifest.webmanifest` with 192 and 512 icons
  (include a maskable one). Icons: simple original placeholders (generate as PNG).
- Dark mode by default, respect `prefers-color-scheme`.

## UX guidelines

- Streak numbers are the visual focus: large, bold, high contrast. Everything else secondary.
- Thumb-friendly: large tap targets, bottom navigation, no tiny controls.
- First paint from cache, then refresh in the background.
- Clean, minimal, original look. Do not copy Habitica's art.

## Deliverables

- Small, clear file structure; comments only where logic is non-obvious.
- `.gitignore` covering `.env`, `*.env`, secrets files, raw API dumps.
- `README.md`: what it is; getting User ID + API token (Habitica → Settings → Site Data → API);
  local dev; deployment (GitHub Pages); adding to iPhone Home Screen; CORS note (no proxy needed, and why);
  **Known limitations** (iOS PWA restrictions, storage eviction risk → use Export/Import,
  streaks only update after Habitica cron, rate limits).

## Working style

1. Phase 0 → summarize findings to the owner.
2. Build v1, test locally with Playwright at iPhone viewport, commit, push to `main`.
3. Confirm the Pages deploy succeeded and give the owner the URL plus Home Screen steps.
4. Then v2.

Keep this file updated as the project's source of truth when decisions change.
