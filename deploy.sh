#!/usr/bin/env bash
# Run inside an already reviewed checkout. The process manager owns restarts;
# this script never deletes a checkout, fetches a branch or copies secrets.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export NODE_ENV=production
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer is required"); process.exit(1); }'
npm ci --omit=dev --omit=optional --ignore-scripts
npm run check:production
exec npm start
