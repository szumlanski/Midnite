# ui-check: headless screenshots with fake data

- Full run: `bash scripts/ui-check/run.sh` snapshots the repo into `scripts/ui-check/.build/app`, builds it with `NEXT_PUBLIC_SUPABASE_URL=https://stub.supabase.co`, serves it on port 3100, shoots, and stops the server.
- Pass harness flags through: `bash scripts/ui-check/run.sh --only fleet,live,day --reduced --out /tmp/shots`.
- Env: `UI_CHECK_SKIP_BUILD=1` reuses the last build, `UI_CHECK_IN_PLACE=1` builds in the repo's own `.next`, `UI_CHECK_PORT` changes the port.
- Against a server you already run: `node scripts/ui-check/shots.mjs --base http://localhost:3100`.
- Screens: landing, fleet, live, live-scrolled, day, month, year, explorer, admin, settings, settings-alerts, settings-sharing, share; each as `<name>-390.png` (2x) and `<name>-1280.png`. Modals and live-scrolled are viewport shots, the rest full-page.
- `--reduced` emulates `prefers-reduced-motion: reduce` and writes into `<out>/reduced/`.
- All `/api/midnite` calls are answered by `fixtures.mjs` (`respond(action, body)`); Supabase is a seeded localStorage session; every other host is aborted (only Google Fonts pass).
- The last stdout line is JSON: `{screens, errs, blocked, failedSteps, blockedHosts, fallbackActions}`; exit 1 on console/page errors, 2 on failed steps.
- To change the data, edit the `SITES` model in `fixtures.mjs`; day, month, year and dayexcel all come from one per-site day simulation, so Day totals equal the Month rollup.
