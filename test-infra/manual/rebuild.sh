#!/usr/bin/env bash
# Rebuild dist/ and the hoop-claude-runner image after editing src/.
# The Dockerfile lives in test-infra/claude-runner/ but copies dist/, hooks/,
# skills/, etc. from the repo root — so the build context must be `.`.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "[rebuild.sh] tsc → dist/"
npm run build

echo "[rebuild.sh] docker build hoop-claude-runner"
docker build -t hoop-claude-runner -f test-infra/claude-runner/Dockerfile .

echo "[rebuild.sh] done — manual scripts now use the new image"
