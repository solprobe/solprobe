# QC Log

## 2026-03-28

### Environment
- PM2 process: solprobe (ID 0)
- LLM: Anthropic (primary) + Groq (fallback)

### Results

--- quick scan (BONK) ---
{
  "grade": "A",
  "confidence": "HIGH",
  "summary_len": 153,
  "summary": "Excellent security profile with revoked authorities and no rug risk, but concentrated ownership (40.3% in top 10) poses moderate exit liquidity concerns."
}

--- invalid address (must be 400) ---
✅ 400 returned correctly

--- health check ---
{
  "status": "ok",
  "degraded": [],
  "uptime": 39
}

--- done ---