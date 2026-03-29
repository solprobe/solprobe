#!/bin/bash
set -e

mkdir -p logs

npx tsx src/api/server.ts &
SERVER_PID=$!

echo "Waiting for API server..."
until curl -sf http://localhost:8000/health > /dev/null 2>&1; do
  sleep 0.5
done
echo "API server ready."

trap "kill $SERVER_PID 2>/dev/null" EXIT
wait $SERVER_PID