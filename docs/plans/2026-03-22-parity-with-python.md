# TypeScript SDK Parity with Python SDK

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring `@blockrun/llm` TypeScript SDK to feature parity with `blockrun-llm` Python SDK on developer experience features.

**Architecture:** Add missing utility modules to the existing TS SDK without changing core API/payment logic.

**Tech Stack:** TypeScript, Node.js, viem, @solana/web3.js

---

## Missing Features (from Python SDK)

| Feature | Python File | Priority |
|---------|------------|----------|
| Response caching | `cache.py` | High — saves duplicate payments |
| Wallet scanning | `wallet.py:scan_wallets()` | High — brcc needs this |
| `setupAgentWallet()` | `wallet.py:setup_agent_wallet()` | High — one-line setup |
| `status()` | `wallet.py:status()` | Medium |
| Cost logging | `wallet.py` + disk writes | Medium |
| Solana balance check | `solana_client.py:get_solana_usdc_balance()` | Medium |
| Solana wallet scanning | `solana_wallet.py:scan_solana_wallets()` | Medium |
| Standalone `listModels()` | `client.py` | Low |
| Formatting helpers | `wallet.py:format_*` | Low |

---

## Task 1: Response Caching

**Files:**
- Create: `src/cache.ts`
- Modify: `src/client.ts` (add cache check before API call)

Cache location: `~/.blockrun/cache/`
TTL varies by endpoint (chat: skip, X/Twitter: 1h, search: 15m, models: 24h).
Hash-based cache keys include request body.

Key functions:
- `getCached(key: string): CachedResponse | null`
- `setCache(key: string, response: unknown, ttlMs: number): void`
- `clearCache(): void`
- `getCacheStats(): { entries: number, sizeBytes: number }`

**Step 1:** Read Python `cache.py` at `/Users/vickyfu/Documents/blockrun-web/blockrun-llm/blockrun_llm/cache.py`
**Step 2:** Create `src/cache.ts` with equivalent logic
**Step 3:** Wire into `client.ts` — cache X/Twitter, search, models responses
**Step 4:** Export from `src/index.ts`
**Step 5:** Commit

---

## Task 2: Wallet Scanning

**Files:**
- Modify: `src/wallet.ts`
- Modify: `src/solana-wallet.ts`

Add functions that Python SDK has:

**Base wallet scanning (`wallet.ts`):**
- `scanWallets(): WalletInfo[]` — scan `~/.*/ wallet.json` files for `privateKey` + `address` fields, sorted by mtime

**Solana wallet scanning (`solana-wallet.ts`):**
- `scanSolanaWallets(): SolanaWalletInfo[]` — scan `~/.*/solana-wallet.json` and `~/.brcc/wallet.json` for Solana keys

**Step 1:** Read Python `wallet.py:scan_wallets()` and `solana_wallet.py:scan_solana_wallets()`
**Step 2:** Add `scanWallets()` to `src/wallet.ts`
**Step 3:** Add `scanSolanaWallets()` to `src/solana-wallet.ts`
**Step 4:** Update `getOrCreateWallet()` to check scanned wallets first
**Step 5:** Export new functions from `src/index.ts`
**Step 6:** Commit

---

## Task 3: setupAgentWallet + status

**Files:**
- Create: `src/setup.ts`
- Modify: `src/index.ts`

One-line entry points for agent runtimes:

```typescript
// setupAgentWallet() — auto-create wallet, return ready client
export function setupAgentWallet(options?: { silent?: boolean }): LLMClient

// setupAgentSolanaWallet() — same for Solana
export function setupAgentSolanaWallet(options?: { silent?: boolean }): SolanaLLMClient

// status() — print wallet + balance, return info
export async function status(): Promise<{ address: string; balance: number }>
```

**Step 1:** Read Python `wallet.py:setup_agent_wallet()` and `status()`
**Step 2:** Create `src/setup.ts`
**Step 3:** Export from `src/index.ts`
**Step 4:** Commit

---

## Task 4: Solana Balance Check

**Files:**
- Modify: `src/solana-client.ts`

Add `getBalance()` method to `SolanaLLMClient` that checks actual on-chain USDC balance.

**Step 1:** Read Python `solana_client.py` for balance check logic
**Step 2:** Add `getBalance()` to `SolanaLLMClient`
**Step 3:** Commit

---

## Task 5: Cost Logging

**Files:**
- Create: `src/cost-log.ts`
- Modify: `src/client.ts`

Log each API call's cost to `~/.blockrun/data/costs.jsonl`:
```json
{"timestamp":"2026-03-22T10:00:00Z","model":"openai/gpt-5.4","inputTokens":100,"outputTokens":50,"costUsd":0.002}
```

Functions:
- `logCost(entry: CostEntry): void`
- `getCostSummary(): { totalUsd: number, calls: number, byModel: Record<string, number> }`

**Step 1:** Create `src/cost-log.ts`
**Step 2:** Wire into `client.ts` after successful API calls
**Step 3:** Export from `src/index.ts`
**Step 4:** Commit

---

## Task 6: Build, Test, Publish

**Step 1:** `pnpm build` — fix any type errors
**Step 2:** `pnpm test` — run existing tests
**Step 3:** Bump version to 1.3.0 in package.json
**Step 4:** Update README with new features
**Step 5:** Commit and push
