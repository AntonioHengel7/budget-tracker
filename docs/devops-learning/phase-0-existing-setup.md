# Phase 0 — Understanding the existing setup

## Concepts

- **Multi-stage Docker build**: use throwaway stages with full build tooling
  (compilers, devDependencies) and copy only compiled output into a lean
  final runtime stage. Smaller image, smaller attack surface.
- **Drop privileges at runtime**: start a container as root only long enough
  to fix ownership on a mounted volume, then exec the real process as an
  unprivileged user. `exec` matters — it replaces the shell so the app
  becomes PID 1 and receives signals directly (clean shutdowns).
- **Platform health checks**: the host (Fly) polls an HTTP endpoint to decide
  whether to route traffic to a machine, and can scale a machine to zero when
  idle if state lives outside the process (on a volume), not in memory.
- **CI gate before deploy**: build the real artifact, smoke-test the real
  artifact (not just "does it compile"), and only deploy on merge to main —
  never on a PR.

## Files walked through

- `Dockerfile` — 3 stages: `web-build` (SPA), `server-build` (TS server),
  `runtime` (node:22-alpine + `su-exec`, copies compiled output from both
  earlier stages, no devDependencies).
- `entrypoint.sh` — `mkdir -p` the data dir, `chmod 700` + `chown node:node`
  it, then `exec su-exec node "$@"` to drop root and become PID 1.
- `fly.toml` — `[[mounts]]` binds the only persistent state (`budget_data` →
  `/data`); `[http_service.checks]` polls `/healthz`; `min_machines_running
  = 0` enables scale-to-zero; secrets are deliberately absent from this file.
- `.github/workflows/ci.yml` — `ci` job (typecheck, coverage gate, docker
  build, then runs the built image and polls `/healthz`), `web` job
  (frontend typecheck/coverage/build, independent, output unused by the
  image), `deploy` job (`needs: [ci, web]`, gated on
  `github.ref == 'refs/heads/main'`, `concurrency: deploy-production`, runs
  `flyctl deploy`).

## Key lines

| # | File:Line | What | Break it and... |
|---|---|---|---|
| 1 | `Dockerfile:21` | `FROM node:22-alpine AS runtime` starts a fresh stage | Ship devDependencies + source + compiler in prod |
| 2 | `Dockerfile:27-28` | `COPY --from=` pulls compiled output across stages | Runtime image has no `dist/` to run |
| 3 | `Dockerfile:40` | `ENTRYPOINT ["/entrypoint.sh"]` forces every boot through the privilege-drop script | App runs as root, or can't write to `/data` |
| 4 | `entrypoint.sh:3` | `mkdir -p` must run before `chown` | `chown` on a nonexistent path fails; `set -e` kills the script |
| 5 | `entrypoint.sh:4-5` | `chmod 700` + `chown node:node` | Without chown: `EACCES` on first `/data` write. Without chmod: no crash, but weaker least-privilege on sensitive JSON data |
| 6 | `entrypoint.sh:6` | `exec su-exec node "$@"` | Without `exec`, node isn't PID 1 — doesn't get signals directly |
| 7 | `fly.toml:29-31` | `[[mounts]] source = "budget_data"` | Only persistent state in the deployment — remove it and every deploy wipes user data |
| 8 | `fly.toml:38` | `min_machines_running = 0` | Change to `1` and you pay for an always-on machine with no traffic |
| 9 | `ci.yml:124` | `if: github.ref == 'refs/heads/main'` | Only gate stopping every PR push from deploying to prod |
| 10 | `ci.yml:120` | `needs: [ci, web]` | Deploy could ship broken frontend tests/typecheck even though `docker build` alone would still succeed (it only runs `npm run build`, not tests) |

## Quiz — my answers, corrected

1. Why not copy `node_modules` from `server-build` instead of reinstalling
   in `runtime`? My first answer (avoid shipping devDependencies) was right,
   but missed: that stage's `node_modules` *already has* devDependencies, so
   copying would still require pruning — no cheaper than reinstalling.
   Bonus: reinstalling from `package*.json` alone keeps that Docker layer
   cached across code changes that don't touch dependencies.

2. What breaks if `chmod 700` is removed, or if `chown` runs before
   `mkdir -p`? Removing `chmod 700` doesn't crash anything — it's a
   least-privilege hardening step on data with financial info, not a
   functional requirement. Swapping the order **does** break startup:
   `chown` on a path that doesn't exist yet fails, and `set -e` kills the
   script immediately.

3. What does `needs: [ci, web]` protect against, and why isn't it enough on
   its own? I only had the "what" (both jobs must pass). The real point:
   the image's frontend is built separately, *inside* Docker's `web-build`
   stage, via plain `npm run build` — no typecheck, no tests. The `web` job
   is the only place those run, and its output is never used in the image.
   So the gate exists to stop deploying an image that boots fine but has a
   frontend that fails typecheck/tests — something `docker build` alone
   would never catch.

## Decisions

- Working branch for all devops-learning work: `devops-learning/phase-0`
  (branched from `main`), per the "work on feature branches" rule.
- No app code or infra changed in this phase — read-only walkthrough plus
  this notes file.
