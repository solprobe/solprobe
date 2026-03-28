# QC Log

## 2026-03-28

### Environment
- PM2 process: solprobe (ID 0)
- LLM: Anthropic (primary) + Groq (fallback)

### Results

| Token | Service | Grade | Confidence | Summary quality | Status |
|---|---|---|---|---|---|
| BONK | sol_quick_scan | A | HIGH | LLM prose |  Pass |

### Rejection handling
- Invalid address → 400 

### Health
- Status: ok 
- Degraded sources: none 

### Notes
- LLM keys confirmed working — summaries returning analyst prose (153 chars)
- Deterministic template fallback confirmed working when keys unset
- Birdeye circuit breaker was OPEN on startup (non-critical, fallback source only)