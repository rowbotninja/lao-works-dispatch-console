# Lao-Works Dispatch Console

Dispatcher React + TypeScript app (Vite) implementing MVP flows:
- Login
- Dispatch queue
- Queue filters + sorting
- Job detail
- Candidate score breakdown
- Candidate-driven assign/override
- Timeline filters + inline action chips
- Structured timeline and candidate summaries (raw JSON in expandable details)
- Messaging panel grouped by day/sender threads
- Keyboard-first dispatcher shortcuts
- Auto-refresh polling

## Run
1. `npm i` (or `pnpm i`)
2. `npm run dev`
3. `npm test`

Set `VITE_API_BASE_URL` if gateway is not `http://localhost:4000/v1`.

## Deployed Dev URL
- UI: `http://dev-dispatch.lao-works.rowbot.lan`
- API: `http://dev-api.lao-works.rowbot.lan/v1`
