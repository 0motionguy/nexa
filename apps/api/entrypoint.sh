#!/bin/sh
# Container entrypoint: run pending migrations, then exec the API server.
# Skipping migrations is safe — migrate.ts no-ops when DATABASE_URL is unset.
set -e
node dist/migrate.js
exec node dist/index.js
