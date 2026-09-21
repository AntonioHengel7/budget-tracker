# Runbook: MySQL restore from backup

**Use this when:** the `DatabaseUnreachable` alert is firing due to actual data loss (a bad `DROP`/`DELETE`, a corrupted table, a botched migration) — not a transient network blip or a MySQL pod that just needs a restart. If MySQL is merely down but the data is intact, restarting the Pod (`kubectl delete pod mysql-0 -n moonbudget` — the StatefulSet recreates it and reattaches the same PVC, per Phase 2) is the fix, not a restore.

This procedure was tested end-to-end on 2026-09-21: a canary row was inserted, backed up, the table was dropped (simulating real data loss), and restored successfully from that exact backup file. The steps below are the real, run commands from that drill, not a hypothetical.

## 1. Confirm you actually need a restore, not a pod restart

```
kubectl get pods -n moonbudget mysql-0
kubectl exec -n moonbudget mysql-0 -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SHOW DATABASES;"'
```

If `mysql-0` isn't `Running`, that's an availability problem (see `docs/runbooks/app-down.md`'s triage steps, same idea applied to `mysql` instead of `app`). Only proceed with a restore if the *data itself* is what's wrong.

## 2. Find the backup to restore from

Backups are written daily at 02:00 by the `mysql-backup` CronJob (`infra/k8s/09-mysql-backup-cronjob.yaml`) to the `mysql-backups` PVC, as `/backups/backup-<timestamp>.sql` (full `--all-databases` dumps, so a restore recovers users/grants too, not just table data).

```
kubectl get cronjob mysql-backup -n moonbudget
kubectl get jobs -n moonbudget -l job-name  # recent runs, check for failures
```

To list available backup files, run a short-lived debug pod against the same PVC:

```
kubectl run backup-debug --rm -it --restart=Never -n moonbudget \
  --image=mysql:8 --overrides='
{
  "spec": {
    "containers": [{"name":"debug","image":"mysql:8","command":["sh"],"stdin":true,"tty":true,
      "volumeMounts":[{"name":"backups","mountPath":"/backups"}]}],
    "volumes": [{"name":"backups","persistentVolumeClaim":{"claimName":"mysql-backups"}}]
  }
}' -- sh
# inside the pod:
ls -la /backups
```

Pick the most recent backup from *before* the data loss occurred — not necessarily the single most recent file if the bad `DROP`/corruption already happened before today's scheduled run.

## 3. Restore

From a terminal with `kubectl` access (this pipes the dump straight from the backups PVC into `mysql`, no local copy needed):

```
kubectl run backup-debug --restart=Never -n moonbudget --image=mysql:8 \
  --overrides='{"spec":{"containers":[{"name":"debug","image":"mysql:8","command":["sleep","3600"],
  "volumeMounts":[{"name":"backups","mountPath":"/backups"}]}],
  "volumes":[{"name":"backups","persistentVolumeClaim":{"claimName":"mysql-backups"}}]}}'

kubectl exec -n moonbudget backup-debug -- sh -c 'cat /backups/<chosen-backup-file>.sql' \
  | kubectl exec -i -n moonbudget mysql-0 -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'

kubectl delete pod backup-debug -n moonbudget
```

This restores every database in the dump (including the system `mysql` schema's users/grants) into the running `mysql-0` instance. It does not require deleting or recreating the MySQL Pod/PVC.

## 4. Verify

```
kubectl exec -n moonbudget mysql-0 -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SHOW TABLES FROM budgettracker;"'
```

Confirm the specific table/rows that were lost are actually back — don't just confirm the restore command exited 0. Then confirm the app itself is healthy against the restored database:

```
kubectl port-forward -n moonbudget svc/app 8080:8080
curl localhost:8080/healthz/db   # expect {"ok":true,"enabled":true}
```

In Prometheus, confirm `probe_success{instance="http://app.moonbudget.svc.cluster.local:8080/healthz/db"}` is back to `1` and `DatabaseUnreachable` has returned to `inactive`.

## 5. Write down what happened

Note the root cause (what was dropped/corrupted, and how), which backup file was restored from, and how much data (if any) was lost between that backup and the incident — anything written after the backup's timestamp and before the restore is gone. This is exactly why the backup schedule/retention should match how much data loss is actually acceptable; a once-daily backup means up to ~24h of data can be lost in the worst case.
