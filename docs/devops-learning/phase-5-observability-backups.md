# Phase 5 — Observability and database operations

## Vocabulary

- **Metric**: a numeric measurement over time (e.g. "is this endpoint
  up: 1 or 0"). **Prometheus** collects metrics by periodically pulling
  (scraping) them from targets.
- **Blackbox probing**: checking a system from the *outside*, by actually
  making a request to it, rather than reading metrics it exposes about
  itself. `blackbox_exporter` does this: it makes the HTTP request and
  turns the result into a Prometheus metric (`probe_success`).
- **Alert rule**: a Prometheus query that, when true for a sustained
  duration (`for:`), transitions from `inactive` → `pending` → `firing`.
  Firing is what would page someone in a real setup (this phase wires the
  rule and proves it fires — it deliberately does not wire a real
  notification channel, see Decisions).
- **Log aggregation**: collecting logs from many containers into one
  searchable place. **Loki** stores them; **Promtail** is the agent that
  reads each node's container logs and ships them to Loki.
- **CronJob**: a Kubernetes object that runs a Job on a schedule (the same
  cron syntax as Unix `crontab`).
- **Backup atomicity**: a backup file must never exist, at its final name,
  in a partially-written state — otherwise a restore procedure that just
  picks "the most recent file" can silently pick a corrupt one.

## What problem this solves, and how it connects to earlier phases

Every phase so far added a `/healthz`/`/healthz/db` endpoint or a
CronJob/StatefulSet, but nothing was actually *watching* them
continuously or reacting when they failed — Phase 1-2's health checks are
only checked by whatever's asking at that moment (Fly's edge, Docker,
kubelet). This phase adds the layer that watches continuously and would
tell a human when something's wrong, plus the other half of "production
readiness" for a real database: a tested plan for getting data back after
it's lost, not just infrastructure.

## What was built

- `kube-prometheus-stack` (Prometheus + Alertmanager + Grafana, the
  standard combined Helm chart) + `prometheus-blackbox-exporter` +
  `loki-stack` (Loki + Promtail), all in a `monitoring` namespace on the
  same `kind` cluster from Phase 2.
- A custom `Probe` object (`infra/observability/budget-tracker-probe.yaml`)
  pointing blackbox-exporter at the app's own `/healthz` and
  `/healthz/db` — reusing the exact endpoints every prior phase already
  built, not new ones.
- A custom `PrometheusRule` (`infra/observability/budget-tracker-alerts.yaml`)
  with two alerts, `AppDown` (`/healthz`, 1 minute) and
  `DatabaseUnreachable` (`/healthz/db`, 2 minutes).
- A Grafana datasource ConfigMap wiring up Loki automatically via
  kube-prometheus-stack's sidecar (no manual "Add data source" click).
- A MySQL backup `CronJob` (`infra/k8s/09-mysql-backup-cronjob.yaml`,
  mirrored in the Helm chart) running `mysqldump --all-databases
  --single-transaction` daily, writing atomically (dump to `.part`, `mv`
  on success — see Phase 5's own fixed bug below).
- Two runbooks (`docs/runbooks/app-down.md`, `database-restore.md`)
  written from real commands, not templates.

## Key lines

| # | File:Line | What | Break it and... |
|---|---|---|---|
| 1 | `budget-tracker-probe.yaml`: `kind: Probe` (not `ServiceMonitor`) | The Prometheus Operator's purpose-built object for "hit this URL and record success/failure," vs. `ServiceMonitor`'s "scrape this service's own `/metrics`" | Using `ServiceMonitor` here would require hacking relabeling rules to redirect scrapes through blackbox-exporter — `Probe` exists specifically to avoid that |
| 2 | `budget-tracker-alerts.yaml`: `expr: probe_success{instance="..."} == 0` + `for: 1m`/`2m` | The actual "alert on the health endpoints" requirement | Without a `for:` duration, a single transient scrape failure would fire immediately — too noisy for anything with real traffic |
| 3 | `infra/k8s/09-mysql-backup-cronjob.yaml`: dump to `$FILE.part`, then `mv "$TMP" "$FILE"` | Atomicity — the final filename only ever exists once the dump is known-complete | Dumping directly to the final name means a mid-dump failure leaves a truncated file indistinguishable from a good backup — exactly what SOCRATES caught in review |
| 4 | Same file: `export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"` instead of `-p"$MYSQL_ROOT_PASSWORD"` | Keeps the password out of the process's command line (readable via `/proc/<pid>/cmdline` by anything else in the same Pod) | A HOBBES-flagged, low-but-real information-disclosure gap |
| 5 | `values-kube-prometheus-stack.yaml`: `probeSelectorNilUsesHelmValues: true` | Only objects labeled `release: kube-prometheus-stack` are picked up by this Prometheus | Without it, this Prometheus could accidentally scrape/alert on unrelated `Probe`/`PrometheusRule` objects some other chart creates in the cluster |

## What was actually verified live (not just written and hoped)

- Scaled the app Deployment to 0 replicas → watched `probe_success` for
  `/healthz` drop to `0` in Prometheus and the `AppDown` alert transition
  to `firing` within its 1-minute window. Scaled back up → confirmed
  recovery.
- Planted a real canary row in MySQL, ran the backup CronJob manually,
  confirmed the row was genuinely inside the resulting dump file, then
  **dropped the table** (real data loss, not simulated), restored from
  that exact backup, and confirmed both the row and the app's
  `/healthz/db` recovered afterward.

## Quiz (for your own later self-study)

1. Why does `AppDown`'s alert expression check `probe_success` for
   `/healthz` specifically, rather than for `/healthz/db`? (This is the
   same design decision from Phase 2's probes — see if you can explain why
   it applies here too.)
2. The backup CronJob uses `concurrencyPolicy: Forbid`. What could go
   wrong with backups specifically if it were `Allow` instead?
3. `mysqldump --single-transaction` was added after review. What could a
   backup taken *without* it look like if the database was being actively
   written to during the dump?

## Decisions and known limitations (deliberately out of scope)

- `loki-stack` is Grafana's deprecated chart (prints a warning on
  install). Still functionally correct; a real deployment should use the
  newer standalone `grafana/loki` + `grafana/promtail` charts instead.
- No persistence on Prometheus/Grafana/Loki — acceptable for a disposable
  `kind` cluster, not for anything longer-lived.
- Alertmanager has no real notification receiver (no Slack/email webhook)
  — the alert pipeline is complete and provably fires, but nothing
  currently pages anyone. Wiring a real receiver is the natural next step,
  intentionally not built here.
- No backup retention policy on the 500Mi backup PVC, and no alert on the
  backup CronJob itself failing — both real gaps for a production setup,
  filed for later rather than fixed here (see the linked GitHub issue for
  the full list of deferred review notes from this PR).
