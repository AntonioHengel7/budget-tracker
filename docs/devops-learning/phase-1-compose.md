# Phase 1 — Compose + MySQL health check

## Vocabulary (defined once, used throughout)

- **Process**: a running copy of a program.
- **Container**: a sandboxed box that runs one process, with its own
  isolated filesystem, separate from the rest of the machine.
- **Exit code**: the single number a program hands back when it finishes.
  `0` = worked fine, anything else = something went wrong. Not a message,
  not logs — just that one number.
- **HTTP status code**: the 3-digit number a web server sends back with a
  response — `200` = OK, `503` = service unavailable. Different thing from
  an exit code; they're both just small integers.
- **Table / query** (SQL): a database stores data in tables (like labeled
  spreadsheets). A query is a request sent to the database to read or
  compute something.
- **Connection pool**: a small set of already-open connections to a
  database, built once and reused, instead of opening a brand-new
  connection for every single request.
- **Restart policy**: a Docker Engine setting on a container — e.g.
  `restart: unless-stopped` means "if this container's process dies
  unexpectedly, start a fresh one automatically."

## Concepts

- **Docker Compose**: one YAML file that declares multiple containers, how
  they reach each other over the network, and what data persists across
  restarts — instead of manually running `docker run` twice and wiring
  networking/volumes by hand. Direct predecessor to Kubernetes (Phase 2):
  Compose services ≈ Deployments, Compose volumes ≈ PVCs, just without a
  scheduler or self-healing.
- **Health checks are dumb on purpose**: Docker's healthcheck mechanism can
  only read a command's *exit code* — it never parses logs or HTTP
  responses itself. Any script used as a healthcheck exists purely to
  translate "is this thing actually working" into that one exit-code
  number.
- **`depends_on: condition: service_healthy` only fires once**, at
  container startup — like a bouncer checking ID once at the door, not a
  guard patrolling all night. It has zero effect on anything that happens
  after startup.
- **Opt-in configuration**: `/healthz/db` is disabled (`enabled: false`,
  still `200`) unless `DATABASE_URL` is set — a deployment with no database
  configured isn't broken, it just doesn't have one. Mirrors this repo's
  existing pattern for the `signup` feature (gated on `RESEND_API_KEY`).

## What was built

- `infra/docker-compose.yml`: two services, `mysql` (named volume, healthy
  via `mysqladmin ping`) and `app` (builds from the existing root
  `Dockerfile`, waits for MySQL to be healthy before starting, healthchecks
  itself using Node's built-in `fetch` — no extra packages needed).
- `infra/.env.example`: documents the dev-only MySQL credentials; the real
  `infra/.env` stays gitignored.
- `src/server/database.ts`: `createDatabaseHealthCheck(databaseUrl)` builds
  one `mysql2` connection pool at boot, reused by every health check
  (`SELECT 1` — the cheapest possible "are you alive" query).
- `src/server/app.ts`: new `GET /healthz/db` route, same placement as
  `/healthz` (before the rate limiter, never throttled). Returns
  `{ok:true,enabled:false}` if no database configured, `{ok:true,enabled:true}`
  if the check succeeds, `503 {ok:false,enabled:true,error:'database unreachable'}`
  if it fails — the real driver error is never sent to the client (it can
  contain the connection string/credentials).
- `src/server/index.ts`: reads `DATABASE_URL`, wires the pool in only when
  it's set — same conditional pattern already used for `signup`/`staticDir`.
- Data reads/writes are still 100% JSON files — MySQL only proves
  connectivity in this phase, nothing was migrated.

## Key lines

| # | File:Line | What | Break it and... |
|---|---|---|---|
| 1 | `infra/docker-compose.yml` `depends_on: mysql: condition: service_healthy` | App waits for MySQL's healthcheck, not just "container started" | App could start before MySQL can actually authenticate connections |
| 2 | `infra/docker-compose.yml` mysql `healthcheck: mysqladmin ping` | Defines what "ready" means for #1 | Remove it and `depends_on` has nothing to wait on |
| 3 | `infra/docker-compose.yml` app `healthcheck` (`node -e "fetch(...)"`) | Translates an HTTP status code into an exit code Docker can read | Without it, `docker compose ps` can only tell you the process hasn't crashed, not that it's actually serving |
| 4 | `src/server/database.ts` `mysql.createPool(databaseUrl)` | One pool at boot, reused by every check | A pool per health check would redo the connection handshake every single time |
| 5 | `src/server/app.ts` `if (config.database === undefined)` | Makes the endpoint opt-in | Without it, any deployment with no `DATABASE_URL` (today's Fly prod) would crash calling `.checkHealth()` on nothing |
| 6 | `src/server/app.ts` `.catch(() => res.status(503).json({ error: 'database unreachable' }))` | Swallows the real driver error before it reaches the client | Passing the raw error through would leak the connection string/credentials |
| 7 | `src/server/index.ts` `databaseUrl !== undefined && databaseUrl !== ''` | Same opt-in gating as `signup`/`staticDir` | An accidental empty env var could crash boot or silently misconfigure the pool |
| 8 | `infra/.env` (gitignored) vs `infra/.env.example` (committed) | Keeps real credentials out of git, documents the shape | Committing `.env` is the exact habit that causes real credential leaks |

## Quiz — corrected understanding

1. Docker's healthcheck can only read an **exit code** — it never parses
   HTTP responses or logs on its own. The `node -e "fetch(...)"` command
   exists purely to translate an HTTP status code into that one number.
2. `SELECT 1` beats querying a real table because: it's the fastest
   possible round trip (no disk lookup), it runs constantly so cost adds
   up, and tying a health check to a specific table means a rename or an
   empty table could report "unhealthy" for a reason unrelated to whether
   the connection actually works.
3. If MySQL crashes mid-session: Docker's restart policy brings up a
   replacement container, but `depends_on` does nothing at this point (it
   only ever fired once, at startup). The connection pool's existing
   connections break. The *next* request to `/healthz/db` runs `SELECT 1`
   through the pool, that fails, and the `.catch()` block returns `503` —
   reflecting reality live, at the moment of the request, nothing cached.
   Confirmed by directly testing this: `docker compose stop mysql` → `503`,
   `docker compose start mysql` → back to `200`.

## Verification performed

- `npm run typecheck`, `npm run test` (379/379 passing, including 3 new
  `/healthz/db` cases), `npm run gate` (coverage gate) — all clean.
- Real `docker compose up --build`: MySQL became healthy before the app
  started; `/healthz` and `/healthz/db` both returned `200` with MySQL up.
- `docker compose stop mysql` → `/healthz/db` returned `503` with a generic
  error (no leaked connection details) — confirmed live, not just in tests.
- Restarted MySQL → `/healthz/db` returned to `200` automatically.
- Confirmed the existing JSON-backed login path (`/api/login`) behaved
  identically regardless of MySQL's state — no regression to the existing
  data path.
- `docker compose down` — stack torn down; nothing cloud-based, nothing
  billable, nothing to destroy.

## Decisions

- MySQL client: `mysql2` (industry standard, ships its own TypeScript
  types, supports connection pooling and a connection-string constructor).
- Database access is injected into `app.ts` as a `checkHealth()` function
  (dependency injection), mirroring the existing `signup`/`sendEmail`
  pattern — keeps `app.ts` unit-testable without a real MySQL connection.
- No graceful-shutdown/pool-draining logic added — the app has no SIGTERM
  handling anywhere else today either; would be scope creep for a
  health-check-only feature. A real production setup would also want this.
- No CI changes yet (`ci.yml` untouched — Phase 3), no Kubernetes (Phase 2),
  no data migration to MySQL (reads/writes stay JSON, per instruction).
