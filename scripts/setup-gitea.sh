#!/usr/bin/env bash
# Initialises Gitea after docker compose starts:
#   - creates the admin user (idempotent)
#   - creates a fresh API token
#   - creates the test repo (idempotent)
# Outputs shell-sourceable env vars: GITEA_TOKEN, GITEA_CLONE_URL
set -euo pipefail

GITEA_URL="${GITEA_URL:-http://localhost:3000}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.test.yml}"
ADMIN_USER="testadmin"
ADMIN_PASS="testpass123"
ADMIN_EMAIL="testadmin@test.com"
REPO_NAME="hoop-test"
TOKEN_NAME="ci-token"

# Create admin user inside the container (safe to re-run; exits 1 if already exists)
docker compose -f "$COMPOSE_FILE" exec -T gitea \
  gitea admin user create \
    --admin \
    --username "$ADMIN_USER" \
    --password "$ADMIN_PASS" \
    --email "$ADMIN_EMAIL" \
    --must-change-password=false >/dev/null 2>&1 || true

# Delete stale token if it exists, then create a fresh one
curl -sf -X DELETE "$GITEA_URL/api/v1/users/$ADMIN_USER/tokens/$TOKEN_NAME" \
  -u "$ADMIN_USER:$ADMIN_PASS" 2>/dev/null || true

TOKEN_RESP=$(curl -s -X POST "$GITEA_URL/api/v1/users/$ADMIN_USER/tokens" \
  -H "Content-Type: application/json" \
  -u "$ADMIN_USER:$ADMIN_PASS" \
  -d "{\"name\":\"$TOKEN_NAME\",\"scopes\":[\"write:repository\",\"write:user\"]}")

TOKEN=$(echo "$TOKEN_RESP" | jq -r '.sha1 // empty')
if [ -z "$TOKEN" ]; then
  echo "ERROR: could not create Gitea token. API response: $TOKEN_RESP" >&2
  exit 1
fi

# Create repo (ignore 409 Conflict — already exists)
# Use -s without -f so curl always exits 0 and -w captures the real status code.
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$GITEA_URL/api/v1/user/repos" \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$REPO_NAME\",\"private\":false,\"auto_init\":false}")

if [ "$HTTP_STATUS" != "201" ] && [ "$HTTP_STATUS" != "409" ]; then
  echo "ERROR: unexpected HTTP $HTTP_STATUS when creating repo" >&2
  exit 1
fi

echo "GITEA_TOKEN=$TOKEN"
echo "GITEA_CLONE_URL=http://${ADMIN_USER}:${TOKEN}@localhost:3000/${ADMIN_USER}/${REPO_NAME}.git"
echo "GITEA_ADMIN_USER=$ADMIN_USER"
echo "GITEA_REPO_NAME=$REPO_NAME"
