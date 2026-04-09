#!/bin/sh
set -e
export DATABASE_URL="${DATABASE_URL:-file:/app/data/data.db}"
npx prisma db push --accept-data-loss --config prisma.config.ts
exec node dist/src/main.js
