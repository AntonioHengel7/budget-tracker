# Observability stack

Deploys Prometheus + Alertmanager + Grafana (via `kube-prometheus-stack`) and
Loki + Promtail (via `loki-stack`) onto the same `kind` cluster from Phase 2,
plus a custom `Probe` and `PrometheusRule` that alert on this app's own
`/healthz` and `/healthz/db` endpoints.

## Deploy (assumes the app is already installed via `infra/helm/budget-tracker`, see repo root docs)

```
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace -f infra/observability/values-kube-prometheus-stack.yaml

helm install prometheus-blackbox-exporter prometheus-community/prometheus-blackbox-exporter -n monitoring

helm install loki grafana/loki-stack -n monitoring -f infra/observability/values-loki-stack.yaml

kubectl apply -f infra/observability/loki-datasource-configmap.yaml \
              -f infra/observability/budget-tracker-probe.yaml \
              -f infra/observability/budget-tracker-alerts.yaml
```

## Verify

```
# Prometheus targets/alerts
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
curl -s 'http://localhost:9090/api/v1/query?query=probe_success'
curl -s http://localhost:9090/api/v1/alerts

# Grafana (admin / see below for password)
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
kubectl get secret kube-prometheus-stack-grafana -n monitoring -o jsonpath='{.data.admin-password}' | base64 -d
```

Live-tested 2026-09-21: scaling `app` to 0 replicas in `moonbudget` made
`probe_success` for `/healthz` drop to `0` and the `AppDown` alert transition
to `firing` within its 1-minute `for:` window; scaling back to 1 replica
brought both back to healthy.

## Known limitations (deliberately out of scope for this pass)

- `loki-stack` is Grafana's deprecated chart (the install prints a warning).
  It still works, but a real deployment should use the newer standalone
  `grafana/loki` chart with `grafana/promtail` alongside it instead.
- No persistence on Prometheus/Grafana/Loki -- fine for a disposable `kind`
  cluster, not for anything longer-lived.
- Alertmanager has no real notification receiver configured (no Slack/email
  webhook) -- the alert pipeline is complete and provably fires, but nothing
  currently pages anyone. Wiring a real receiver is the natural next step.
- No custom Grafana dashboards provisioned -- metrics/logs are queryable via
  Explore, but nothing is pre-built.

## Teardown

```
helm uninstall loki -n monitoring
helm uninstall prometheus-blackbox-exporter -n monitoring
helm uninstall kube-prometheus-stack -n monitoring
kubectl delete namespace monitoring
```
