#!/bin/bash
set -e

BASE="http://localhost:8000"

# Check server is up first
if ! curl -sf "$BASE/health" > /dev/null 2>&1; then
  echo "❌ Server not reachable at $BASE — is it running?"
  exit 1
fi
echo "✅ Server reachable"

echo ""
echo "--- quick scan (BONK) ---"
curl -s -X POST "$BASE/scan/quick" \
  -H "Content-Type: application/json" \
  -d '{"token_address": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}' | \
  jq '{grade: .risk_grade, confidence: .data_confidence, summary_len: (.summary | length), summary: .summary}'

echo ""
echo "--- invalid address (must be 400) ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/scan/quick" \
  -H "Content-Type: application/json" \
  -d '{"token_address": "garbage"}')
if [ "$STATUS" = "400" ]; then
  echo "✅ 400 returned correctly"
else
  echo "❌ Expected 400, got $STATUS"
fi

echo ""
echo "--- health check ---"
curl -s "$BASE/health" | \
  jq '{status: .status, degraded: .degraded_sources, uptime: .uptime_seconds}'

echo ""
echo "--- done ---"