#!/usr/bin/env bash
# .jome/verify.sh — build/test verification, run by pre-merge-gate.sh (Step (c)).
# Coverage itself is NOT regenerated here — the merge gate reads coverage/coverage-summary.json
# off disk, which must already exist from `npm run gate` run on the checked-out PR head.
set -euo pipefail
npm run typecheck
npm test
