# Exa Web Search — E2E Integration Test Note

**Feature:** Exa neural web search via sol.blockrun.ai
**Payment:** Solana USDC (x402)
**Estimated cost per full run:** ~$0.04
**Date added:** 2026-03-31

---

## What's Being Tested

| Test | Endpoint | Expected Cost |
|---|---|---|
| `exaSearch returns results` | `POST /api/v1/exa/search` | $0.01 |
| `exaFindSimilar returns pages` | `POST /api/v1/exa/find-similar` | $0.01 |
| `exaContents extracts text` | `POST /api/v1/exa/contents` | $0.002/URL |
| `exaAnswer returns answer` | `POST /api/v1/exa/answer` | $0.01 |
| `exa() generic proxy works` | `POST /api/v1/exa/search` (via `exa()`) | $0.01 |
| `session spending tracked` | Session tracking across all calls | — |

---

## Setup

### 1. Install dependencies

```bash
git clone https://github.com/BlockRunAI/blockrun-llm-ts
cd blockrun-llm-ts
npm install
```

### 2. Prepare a Solana wallet with USDC

- Solana mainnet wallet with at least **$0.10 USDC**
- Private key must be **bs58-encoded** (64-byte keypair, standard Solana format)
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

### 3. Set environment variable

```bash
export SOLANA_WALLET_KEY="your-bs58-private-key-here"
```

---

## Run the Tests

```bash
# Run only Exa E2E tests
npx vitest run test/integration --reporter=verbose

# Or with npm script
npm test -- test/integration
```

Expected output:

```
✓ Solana + Exa Integration > exaSearch returns results with url/title
   ✓ exaSearch: 3 results, cost=$0.0100
✓ Solana + Exa Integration > exaFindSimilar returns semantically similar pages
   ✓ exaFindSimilar: 3 results
✓ Solana + Exa Integration > exaContents extracts text from URL
   ✓ exaContents: response received
✓ Solana + Exa Integration > exaAnswer returns AI-generated answer from live web
   ✓ exaAnswer: response received
✓ Solana + Exa Integration > exa() generic proxy works
   ✓ exa() generic: 2 results
✓ Solana + Exa Integration > session spending is tracked across Exa calls
   ✓ Spending: $0.0400 over 5 calls
```

---

## Manual API Smoke Test (no wallet needed)

Verify endpoints are live and pricing is correct:

```bash
# search — expect $0.0100
curl -s -X POST https://sol.blockrun.ai/api/v1/exa/search \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}' | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d); console.log('price:',j.price,'network:',j.paymentInfo?.network)})"

# contents with 2 URLs — expect $0.0040 ($0.002 × 2)
curl -s -X POST https://sol.blockrun.ai/api/v1/exa/contents \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://a.com","https://b.com"]}' | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>console.log('price:',JSON.parse(d).price))"

# discovery — should list 4 Exa endpoints
curl -s https://sol.blockrun.ai/api/.well-known/x402 | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).resources.filter(r=>r.includes('exa'))))"
```

All should return HTTP 402 with correct `price` and `network: solana`.

---

## Pass Criteria

- All 6 tests in `Solana + Exa Integration` suite pass
- `exaSearch` cost is exactly $0.01 (±$0.0001)
- `exaContents` cost scales with number of URLs ($0.002 each)
- Session `totalUsd` and `calls` are tracked accurately
- No `APIError` or `PaymentError` on valid requests

## Fail Criteria

- HTTP 503 → `EXA_API_KEY` not configured in Cloud Run (contact DevOps)
- HTTP 402 after payment → wallet has insufficient USDC balance
- Assertion failure on `results` structure → Exa API response format changed

---

## Contact

Questions → @bc1max on Telegram
