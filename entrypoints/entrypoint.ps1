$ErrorActionPreference = "Stop"

if (-not $env:DATABASE_URL) {
    $env:DATABASE_URL = "file:/app/data/data.db"
}

npx prisma db push --accept-data-loss --config prisma.config.ts
node dist/src/main.js
