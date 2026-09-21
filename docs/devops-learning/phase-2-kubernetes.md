# Phase 2 — Kubernetes on kind (plain manifests)

## Vocabulary (new this phase)

- **Cluster**: a group of machines Kubernetes manages as one unit. `kind`
  fakes an entire cluster using regular Docker containers on one laptop, so
  you get the real objects/commands without needing real servers.
- **Pod**: the smallest thing Kubernetes runs — one or more containers
  scheduled together. Every Pod here holds exactly one container.
- **Deployment**: "keep N identical, interchangeable copies of this Pod
  running." A dead Pod gets replaced automatically, with a random new name
  — no individual Pod matters on its own.
- **StatefulSet**: like a Deployment, but for Pods that need a stable
  identity and their own dedicated storage. Pods get deterministic names
  (`mysql-0`, `mysql-1`, ...) and each ordinal keeps its own
  auto-created PersistentVolumeClaim across restarts.
- **Service**: a stable network name that routes to whichever Pods
  currently match its selector. A **headless Service** (`clusterIP: None`)
  skips load-balancing and lets DNS resolve straight to the backing Pod(s)
  — the conventional pairing for a StatefulSet.
- **ConfigMap / Secret**: two ways to hand a Pod its configuration.
  ConfigMap = ordinary settings. Secret = sensitive values, but only
  base64-*encoded* by default, not encrypted — anyone with read access to
  Secrets in the namespace can trivially decode one.
- **PersistentVolumeClaim (PVC)**: a request for storage that survives a
  Pod being deleted and recreated.
- **Readiness probe / liveness probe**: recurring automatic health checks.
  Readiness = "can this Pod take traffic right now?" Liveness = "is this
  still working, or should it be killed and restarted?" Run by **kubelet**,
  the per-node agent that actually starts containers and checks on them —
  an `httpGet` probe is kubelet making a plain HTTP request, same as
  `curl` would.
- **CoreDNS**: the DNS server every cluster runs automatically. It watches
  for Service objects and auto-creates a DNS name for each one
  (`<service>.<namespace>.svc.cluster.local`) — no manual wiring. A Pod in
  the same namespace can use just the short name.
- **Namespace**: a named grouping of objects inside a cluster, so unrelated
  things (or copies of the same thing) don't collide.

## What was built

Everything under `infra/k8s/`, applied as one `moonbudget` namespace:

- `00-namespace.yaml`
- `01-configmap.yaml` — non-sensitive settings only
  (`PORT`, `DATA_DIR`, `TRUST_PROXY=0`, `MYSQL_DATABASE`,
  `INSECURE_COOKIES=true` for the plain-HTTP `kubectl port-forward` path).
- `examples/secret.example.yaml` (committed placeholder) →
  `infra/k8s/secret.yaml` (gitignored, dev-only real values) — same
  `.env`/`.env.example` split as Phase 1.
- `03-pvc.yaml` — the app's `/data`, `ReadWriteOnce`.
- `04-mysql-statefulset.yaml` — 1 replica, storage via
  `volumeClaimTemplates` (not a standalone PVC — the core StatefulSet vs.
  Deployment difference), probes via `exec: mysqladmin ping` (needs `sh -c`
  so `$MYSQL_ROOT_PASSWORD` actually expands).
- `05-mysql-service.yaml` — headless (`clusterIP: None`).
- `06-app-deployment.yaml` — `replicas: 1` (JSON storage can't safely
  support more, same as Phase 1), probes on plain `/healthz` (not
  `/healthz/db` — app readiness stays independent of MySQL), image loaded
  in via `kind load docker-image` rather than pulled from a registry.
- `07-app-service.yaml` — normal ClusterIP Service.

Data reads/writes are still 100% JSON — same as Phase 1, this phase proves
orchestration, not migration.

## Key lines

| # | File:Line | What | Break it and... |
|---|---|---|---|
| 1 | `06-app-deployment.yaml` `replicas: 1` | Pins the app to one copy | 2 Pods writing the same JSON files with no locking → corruption |
| 2 | `06-app-deployment.yaml` probes → `/healthz` not `/healthz/db` | Keeps app readiness independent of MySQL | A MySQL blip would pull the whole app out of rotation for a dependency it doesn't need |
| 3 | `04-mysql-statefulset.yaml` `volumeClaimTemplates` | One PVC per StatefulSet replica, tied to its ordinal | A shared PVC (like the app's) would make a future 2nd MySQL replica fight over the same disk |
| 4 | `05-mysql-service.yaml` `clusterIP: None` | Headless Service — the correct StatefulSet pairing | Without it, still routes traffic with 1 replica, but isn't the shape a real multi-replica setup would need |
| 5 | `examples/secret.example.yaml` vs gitignored `secret.yaml` | Real Secret *shape* visible in git, real values never committed | Committing the real file leaks dev-only credentials into git history — the same habit that causes real leaks |
| 6 | `06-app-deployment.yaml` `imagePullPolicy: IfNotPresent` | Stops Kubernetes from trying to pull an image that only exists because `kind load` put it there | Default pull behavior could try (and fail) against a registry that never had this image |
| 7 | `04-mysql-statefulset.yaml` `sh -c 'mysqladmin ping ... "$MYSQL_ROOT_PASSWORD"'` | Runs the probe through a shell so `$VAR` expands | A bare command array has no shell — the literal text `$MYSQL_ROOT_PASSWORD` would be passed instead of the real password |
| 8 | `01-configmap.yaml` `INSECURE_COOKIES: 'true'` | Lets login work over the plain-HTTP `port-forward` this phase uses | Without it, `Secure`-flagged cookies never get sent back over plain HTTP — login silently breaks |

## Quiz — corrected understanding

1. The app became `Ready` before MySQL, and always will in this setup —
   its readiness probe never checks MySQL at all, so ordering is purely
   "whichever finishes booting first" (MySQL takes longer: it initializes
   a fresh data directory on first start). If the app's core functionality
   ever actually depended on MySQL, wiring readiness to `/healthz/db` would
   become the *correct* choice at that point — the rule is "only gate
   readiness on what you actually need," not "never check dependencies."
   Also: `/healthz` and `/healthz/db` are ordinary HTTP endpoints defined
   in `src/server/app.ts` — a `httpGet` probe is just kubelet (the
   per-node agent that runs containers) making a plain HTTP request, the
   same as `curl` would. Same two endpoints have now been hit by: a
   browser/curl, Fly.io's edge check, Docker Compose's healthcheck, and
   Kubernetes's probes.
2. A StatefulSet names Pods deterministically: `<name>-<ordinal>`, so with
   1 replica the replacement is always `mysql-0` again, reattaching to the
   PVC generated with the matching name. A Deployment's Pods get a random
   suffix on purpose — they're meant to be fully interchangeable clones
   with no individual identity, so there's no reason to give them stable
   names.
3. CoreDNS is the DNS server every cluster runs automatically. It watches
   for Service objects and auto-creates a DNS name for each one
   (`mysql.moonbudget.svc.cluster.local`) with zero manual wiring. Pods
   automatically search the current namespace first, so the app Pod (also
   in `moonbudget`) can use just the short name `mysql`. Same idea as
   Phase 1's Compose network — just CoreDNS instead of Docker's DNS.

## Verification performed

- Built `budget-tracker:local`, created a `kind` cluster, `kind load
  docker-image`'d it in.
- `kubectl apply -f infra/k8s/` created all 8 objects; the `examples/`
  subfolder was correctly skipped (directory apply is non-recursive).
- Watched both Pods reach `Running`/`Ready` — app at ~10s, MySQL at ~28s.
- `kubectl port-forward` + `curl` confirmed `/healthz` (200) and
  `/healthz/db` (200, `enabled:true`) against the real cluster.
- Deleted the app Pod → Deployment auto-created a replacement with a new
  random name (self-healing).
- Deleted `mysql-0` → replacement Pod came back as `mysql-0` again,
  reattached to the exact same PVC (`mysql-data-mysql-0`) — data survives.
- `kind delete cluster` — fully torn down, nothing cloud-based, nothing
  billable.

## Decisions

- `kind` and `kubectl` installed via Homebrew / already bundled with
  Docker Desktop.
- Access via `kubectl port-forward` only — NodePort/Ingress/TLS
  deliberately out of scope for this pass, to keep focus on the core
  object types.
- Helm chart: explicitly deferred until the plain manifests were verified
  working (this document) — added as a separate follow-up, not bundled in.
- Real secret management (Vault, sealed-secrets, cluster encryption
  providers) — noted as "what real production would also do," not
  implemented; a bare Secret is only base64-obscured, not encrypted.
