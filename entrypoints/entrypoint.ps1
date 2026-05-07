$ErrorActionPreference = "Stop"

if (-not $env:OPTICS_AGENT_RUNTIME) {
    $env:OPTICS_AGENT_RUNTIME = "container"
}

if (-not $env:DATABASE_URL) {
    $env:DATABASE_URL = "file:/app/data/data.db"
}

npx prisma db push --accept-data-loss --config prisma.config.ts
node dist/src/main.js
