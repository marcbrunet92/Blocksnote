# Blocksnote server

Minimal mono-account HTTP server based on `server.md`.

## 1) Configure environment

Copy `/home/runner/work/Blocksnote/Blocksnote/server/.env.example` to your `.env` and fill:

- `PRONOTE_SCHOOL_URL`
- `PRONOTE_USERNAME`
- `PRONOTE_PASSWORD`
- `PRONOTE_ROLE` (`student`, `teacher`, `parent`, `company`, `assistant`, `administrator`, `schoolLife`)
- `API_KEY`
- `PORT` (optional, default `3000`)

## 2) Run

From repository root:

```bash
bun --env-file ./server/.env ./server/index.ts
```

## 3) Endpoints

- `GET /api/v1/health` (no auth)
- `GET /api/v1/timetable?from=YYYY-MM-DD&to=YYYY-MM-DD`
  - requires `Authorization` header with either:
    - raw API key value
    - bearer scheme followed by the API key
