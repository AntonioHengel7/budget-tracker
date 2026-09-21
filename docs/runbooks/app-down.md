# Runbook: `AppDown` alert

**Fires when:** the `AppDown` Prometheus alert (`infra/observability/budget-tracker-alerts.yaml`) has been active for 1 minute straight — the blackbox-exporter probe against `http://app.moonbudget.svc.cluster.local:8080/healthz` returned anything other than a successful HTTP response (`probe_success == 0`).

**What this means:** the app is not answering its own basic health check. This is independent of the database — `/healthz` never touches MySQL (see `docs/devops-learning/phase-2-kubernetes.md`), so this alert means the app process itself is down, crash-looping, or unreachable on the network, not a database problem. For a database-specific failure, see the separate `DatabaseUnreachable` alert instead.

## 1. Confirm the blast radius

```
kubectl get pods -n moonbudget -l app=budget-tracker
kubectl get deployment app -n moonbudget
```

- `0/1` or no pods at all → the Deployment isn't running a healthy Pod.
- Pod `Running` but `0/1` ready → the container is up but `/healthz` is failing inside it (see step 3).

## 2. Check recent events and logs

```
kubectl describe pod -n moonbudget -l app=budget-tracker
kubectl logs -n moonbudget -l app=budget-tracker --tail=100
kubectl logs -n moonbudget -l app=budget-tracker --previous   # if it's restarting
```

Common causes and what they look like:

- **CrashLoopBackOff, log shows `SESSION_SECRET is not set` or similar boot-time validation error** → the Secret (`budget-secrets`) or ConfigMap (`budget-config`) is missing a required key, or was edited incorrectly. Check `kubectl get secret budget-secrets -n moonbudget -o yaml` and `kubectl get configmap budget-config -n moonbudget -o yaml` against `infra/k8s/examples/secret.example.yaml` / `infra/k8s/01-configmap.yaml`.
- **`ImagePullBackOff`** → the image tag doesn't exist where the Pod expects it. On `kind`, this usually means the image was never `kind load docker-image`'d after a rebuild.
- **Pod `Running`, readiness probe failing** → exec in and check directly: `kubectl exec -n moonbudget <pod> -- wget -qO- http://localhost:8080/healthz`. If that also fails, it's an in-process issue (check logs); if that succeeds but the probe still fails, check for a networking/port mismatch.

## 3. Check whether this is a resource problem, not a code problem

```
kubectl top pod -n moonbudget -l app=budget-tracker
kubectl describe node
```

An `OOMKilled` restart reason in `kubectl describe pod` output means the container ran out of memory — this app has no resource limits set by default (see `infra/k8s/06-app-deployment.yaml`), so this would point to the node itself being memory-pressured, not the app leaking.

## 4. Recover

- If the Pod is just stuck: `kubectl delete pod -n moonbudget <pod-name>` — the Deployment recreates it automatically (this is the same self-healing behavior demonstrated in Phase 2).
- If the image is bad (a recent deploy broke boot): roll back — `kubectl rollout undo deployment/app -n moonbudget` (plain manifests) or `helm rollback budget-tracker <previous-revision> -n moonbudget` (Helm install).
- If config is bad: fix the Secret/ConfigMap, then `kubectl rollout restart deployment/app -n moonbudget` to pick up the change (env vars from a Secret/ConfigMap are not live-reloaded into a running Pod).

## 5. Confirm resolution

```
curl <service>/healthz   # via kubectl port-forward -n moonbudget svc/app 8080:8080
```

Should return `{"ok":true}` with HTTP 200. In Prometheus (`kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090`), confirm `probe_success{instance="http://app.moonbudget.svc.cluster.local:8080/healthz"}` is back to `1` and the `AppDown` alert has returned to `inactive`.

## What this alert deliberately does NOT cover

A MySQL outage alone does not trigger `AppDown` — see `docs/runbooks/database-restore.md` for that case, and `docs/devops-learning/phase-2-kubernetes.md`'s note on why the app's own readiness/liveness probes are intentionally decoupled from the database.
