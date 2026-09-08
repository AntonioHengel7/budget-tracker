# Budget Tracker

A budgeting app you can drive from the command line or the browser — one TypeScript core, two front ends.

Live at [moonbudget](https://moonbudget.fly.dev).

## Features

- Track income/expense transactions, filterable by date, category, kind, or note
- Set per-category monthly limits, with optional rollover of unspent/overspent balance into the next period
- Status and summary views — spend vs. limit, percent used, income/expense/net by period
- Web app with signup + email verification (React), or the same logic via CLI
- Session-based auth, rate-limited and hardened (Helmet, bcrypt password hashing)

## Stack

- **Domain core** (`src/domain`) — pure budgeting logic: transactions, periods, limits, money handling. No I/O, shared by both front ends.
- **CLI** (`src/cli`) — built with Commander, backed by a JSON file store.
- **Server** (`src/server`) — Express 5 API + static host for the web build, with session auth and Resend for transactional email.
- **Web** (`web/`) — React 19 + Vite.
- **Tests** — Vitest, with an enforced coverage gate (`npm run gate`).

## CLI usage

```bash
npm run build
npm link   # puts `budget` on your PATH; skip this and run `node dist/cli/index.js` instead if you'd rather not link

budget add 42.50 groceries --kind expense
budget add 2000 paycheck --kind income
budget list --category groceries
budget limit set groceries 300 --effective-from 2026-09
budget status
budget summary
```

Defaults to `./budget.json`; override with `-f <path>` or the `BUDGET_FILE` env var.

## Running the web app locally

The API server and the frontend run separately in local dev — the server only serves the built frontend as static files when `STATIC_DIR` is set (that's done for you inside Docker/production, not by `npm start` on its own).

```bash
# terminal 1: API server
npm run build
SESSION_SECRET=<32+ char secret> AUTH_USERS_JSON=<see src/server/credentials.ts> npm start

# terminal 2: frontend with hot reload, proxies /api to the server above
cd web && npm run dev
```

To run the real production build (server + frontend served from one process, same as deploy) locally instead, use Docker:

```bash
docker build -t budget-tracker .
docker run -p 8080:8080 -e SESSION_SECRET=<32+ char secret> -e AUTH_USERS_JSON=<...> budget-tracker
```

## Deployment

Deployed on Fly.io — merging to `main` auto-deploys via the Docker image above. Required secrets (`fly secrets set`): `SESSION_SECRET`, `AUTH_USERS_JSON`, and, if self-service signup is enabled, `RESEND_API_KEY` together with `EMAIL_FROM_ADDRESS` and `PUBLIC_APP_URL` (all three are required as soon as `RESEND_API_KEY` is set — the server fails fast at boot otherwise).
