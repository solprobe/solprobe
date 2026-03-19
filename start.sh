#!/bin/bash
set -e

# Create log directory if it doesn't exist
mkdir -p logs

# Start the Hono API server in background
npx tsx src/api/server.ts &
SERVER_PID=$!

# Wait for server to be ready — poll /health instead of blind sleep
echo "Waiting for API server..."
until curl -sf http://localhost:8000/health > /dev/null 2>&1; do
  sleep 0.5
done
echo "API server ready."

# Start ACP seller runtime
cd acp && npx tsx ../../virtuals-acp/node_modules/.bin/acp serve start

# Cleanup on exit
trap "kill $SERVER_PID 2>/dev/null" EXIT
