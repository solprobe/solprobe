# QC Log

## 2026-03-28


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

## 2026-03-29


### Scoring overhaul — new signals live

| Signal | Status | Notes |
|---|---|---|
| Concentration thresholds 60%/90% | ✅ Live | Was 80%/95% — catches HAWK-style rugs |
| LP burn penalty (-25) | ✅ Live | null treated as unburned (conservative) |
| RugCheck risk score penalty (up to -30) | ✅ Live | Bug fixed: was reading normalised score (43) instead of raw (5909) |
| Single holder danger from risks[] (-25) | ✅ Live | Parsed from RugCheck risks array |
| Creator wallet age penalties | ✅ Live | Deep dive only |

### Reference token grading

| Token | Grade | Confidence | Exempt | Key signals | Status |
|---|---|---|---|---|---|
| BONK | A | HIGH | false | Authorities revoked, healthy liquidity | ✅ Pass |
| USDC | A | HIGH | true | Stablecoin — authority penalties exempt | ✅ Pass |
| HAWK (known rug) | D | HIGH | false | rugcheck_score 5909, single_holder true, 71.7% concentration | ✅ Pass |

### Bug fixes applied
- `rugcheck.ts` line 105: `raw.score_normalised ?? raw.score` → `raw.score` directly
- `riskScorer.ts` line 52: `lp_burned === false` → `lp_burned === false || lp_burned === null`

### Regression detection added
- `scripts/qc_smoke.sh` extended with grading sanity checks (HAWK D/F, BONK A, USDC A/B exempt)
- `tests/sources.test.ts` RugCheck mock updated to mirror real API shape (score: 5909)

### Pricing updated
| Service | Old price | New price | SLA |
|---|---|---|---|
| `sol_quick_scan` | $0.02 | $0.05 | < 5s |
| `sol_wallet_risk` | $0.02 | $0.10 | < 20s |
| `sol_market_intel` | $0.05 | $0.10 | < 10s |
| `sol_deep_dive` | $0.50 | $0.50 | < 30s |

### Health
- Status: ok ✅
- Degraded sources: none ✅
- Jupiter token list: loaded ✅

### Open items
- LP burn returning null for HAWK — LP mint address not being extracted from DexScreener pool data. Penalty still applies (null = unburned) but lp_burned field could be more informative once wired correctly.
- `sol_wallet_risk` rebuild in progress — real behavioural signals not yet live
- `sol_market_intel` Agent summary (market_summary field) not yet live## 2026-03-29 — Market Intel overhaul

---
## 2026-03-29

### Changes shipped
- Added `token_health` classification: ACTIVE / LOW_ACTIVITY / DECLINING / ILLIQUID / DEAD
- Added `pct_from_ath` and `ath_price_usd` from Birdeye OHLCV V1 daily candles
- Signal override: DEAD and ILLIQUID tokens always return BEARISH regardless of buy/sell ratio
- LOW_ACTIVITY tokens with unknown or deeply negative ATH override to BEARISH
- data_confidence capped: DEAD/ILLIQUID → LOW, LOW_ACTIVITY → MEDIUM max
- Added `market_summary` Agent field (Haiku) to all market intel responses
- New test file: `tests/marketIntel.test.ts` (9 test cases)

### Bug fixed
- `token_health` not appearing in HTTP response — caused by stale in-memory cache
  serving pre-overhaul result. Fix: `pm2 restart 0` clears cache on deploy.

### Reference token results

| Token | Signal | Health | Volume 24h | Confidence | ATH | Summary quality | Status |
|---|---|---|---|---|---|---|---|
| BONK | BEARISH | — | — | MEDIUM | — | Agent prose ✅ | ✅ Pass |
| HAWK (known rug) | BEARISH | DEAD | $11.47 | LOW | — | Agent correctly flags illiquid | ✅ Pass |
| PIXEL(2522% surge) | BULLISH | — | — | MEDIUM | -33% from ATH | Agent flags ATH drawdown risk ✅ | ✅ Pass |
| GOYIM(93% below ATH) | NEUTRAL | — | $39k | MEDIUM | -93% | Agent says "avoid entirely" ✅ | ✅ Pass |

### Notes
- HAWK correctly classified DEAD + BEARISH + LOW confidence after cache cleared
- Agent summaries adding value beyond structured signals — correctly surfacing ATH
  drawdown context and rug indicators in prose even when structured signal is NEUTRAL
- Third token (93% below ATH, $39k volume) returns NEUTRAL signal — volume above
  LOW_ACTIVITY threshold so override doesn't fire. Agent compensates. Acceptable for now.
- Cache note: in-memory cache survives code deploys. Always run `pm2 restart 0 && sleep 5`
  after deploying changes that add new response fields.

### Health
- Status: ok ✅
- Degraded sources: none ✅
- All 57 tests passing ✅
