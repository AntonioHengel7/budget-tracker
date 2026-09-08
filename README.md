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

budget add 42.50 groceries --kind expense
budget add 2000 paycheck --kind income
budget list --category groceries
budget limit set groceries 300 --effective-from 2026-09
budget status
budget summary
```

Defaults to `./budget.json`; override with `-f <path>` or the `BUDGET_FILE` env var.

## Running the web app

```bash
npm run build          # builds the server
cd web && npm run build  # builds the static frontend
npm start                # serves both from src/server
```

For local frontend development with hot reload: `cd web && npm run dev`.

## Deployment

Deployed on Fly.io — merging to `main` auto-deploys. Requires `SESSION_SECRET`, `AUTH_USERS_JSON`, and `RESEND_API_KEY` set via `fly secrets set`.
