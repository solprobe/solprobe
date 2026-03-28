# All 4 services return correct shape
curl -s -X POST http://localhost:8000/scan/quick \
  -H "Content-Type: application/json" \
  -d '{"token_address": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}' | \
  jq '{grade: .risk_grade, confidence: .data_confidence, summary_len: (.summary | length)}'

# Invalid address returns 400 not 500
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8000/scan/quick \
  -H "Content-Type: application/json" \
  -d '{"token_address": "garbage"}'
# Must print 400

# Health is clean
curl -s http://localhost:8000/health | jq '{status, degraded: .degraded_sources}'
# Must show status: "ok", degraded: []