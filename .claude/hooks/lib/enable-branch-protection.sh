#!/usr/bin/env bash
# =============================================================================
# enable-branch-protection.sh — optional helper
#
# Enables branch protection on `main` for a GitHub repo using the verified
# gh api call (see .jome/README.md § Branch Protection).
#
# Usage:
#   bash .claude/hooks/lib/enable-branch-protection.sh <owner> <repo>
#
# Requires: gh CLI authenticated (gh auth status).
# Fails loud if not authenticated or if the API call fails.
# =============================================================================
set -euo pipefail

OWNER="${1:-}"
REPO="${2:-}"

if [ -z "$OWNER" ] || [ -z "$REPO" ]; then
  echo "Usage: $0 <owner> <repo>" >&2
  echo "  Example: $0 antonioekk14 my-project" >&2
  exit 1
fi

# Fail loud if gh is not authenticated.
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

echo "Enabling branch protection on ${OWNER}/${REPO}/branches/main ..."

# Verified command (gh api --help confirms):
#   -F key=null       sends JSON null (literal null is type-converted)
#   key[subkey]=value sends nested JSON object
gh api -X PUT "repos/${OWNER}/${REPO}/branches/main/protection" \
  -F enforce_admins=true \
  -F required_status_checks=null \
  -F restrictions=null \
  -F "required_pull_request_reviews[required_approving_review_count]=1"

echo "Done. Branch protection enabled on ${OWNER}/${REPO}:main"
