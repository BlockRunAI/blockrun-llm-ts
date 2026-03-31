# Sync TypeScript SDK with Python SDK v0.10.0

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring blockrun-llm-ts to full feature parity with blockrun-llm (Python SDK v0.10.0).

**Architecture:** The TS SDK mirrors the Python SDK's structure but uses TypeScript idioms (camelCase, interfaces, async/await). The router logic lives in `@blockrun/clawrouter` (separate npm package), so router tier updates come via dependency bump. All other gaps are filled directly in this repo.

**Tech Stack:** TypeScript, Node.js, viem, @blockrun/clawrouter

---

### Task 1: Bump @blockrun/clawrouter to latest

The Python SDK v0.10.0 updated all router tier configs (AUTO, ECO, PREMIUM, FREE) with new model assignments. The TS SDK delegates routing to `@blockrun/clawrouter`, currently at 0.10.19 — latest is 0.12.71.

**Files:**
- Modify: `package.json`

**Step 1: Update dependency version**

In `package.json`, change:
```json
"@blockrun/clawrouter": "^0.10.18"
```
to:
```json
"@blockrun/clawrouter": "^0.12.71"
```

**Step 2: Install**

Run: `npm install`

**Step 3: Verify build**

Run: `npm run build`
Expected: Clean build with no errors.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump @blockrun/clawrouter to ^0.12.71 for updated router tiers"
```

---

### Task 2: Add missing validation functions

Python SDK has `validateModel()`, `validateMaxTokens()`, `validateTemperature()`, `validateTopP()`, and `KNOWN_PROVIDERS`. TS SDK is missing all of these.

**Files:**
- Modify: `src/validation.ts`

**Step 1: Add KNOWN_PROVIDERS and validation functions**

Add after the `LOCALHOST_DOMAINS` constant:

```typescript
/** Known LLM providers (for optional validation) */
export const KNOWN_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "mistralai",
  "meta-llama",
  "together",
  "xai",
  "moonshot",
  "nvidia",
  "minimax",
  "zai",
]);

/**
 * Validates model ID format.
 */
export function validateModel(model: string): void {
  if (!model || typeof model !== "string") {
    throw new Error("Model must be a non-empty string");
  }
}

/**
 * Validates max_tokens parameter.
 */
export function validateMaxTokens(maxTokens?: number): void {
  if (maxTokens === undefined || maxTokens === null) return;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens)) {
    throw new Error("max_tokens must be an integer");
  }
  if (maxTokens < 1) throw new Error("max_tokens must be positive (minimum: 1)");
  if (maxTokens > 100000) throw new Error("max_tokens too large (maximum: 100000)");
}

/**
 * Validates temperature parameter.
 */
export function validateTemperature(temperature?: number): void {
  if (temperature === undefined || temperature === null) return;
  if (typeof temperature !== "number") throw new Error("temperature must be a number");
  if (temperature < 0 || temperature > 2) throw new Error("temperature must be between 0 and 2");
}

/**
 * Validates top_p parameter (nucleus sampling).
 */
export function validateTopP(topP?: number): void {
  if (topP === undefined || topP === null) return;
  if (typeof topP !== "number") throw new Error("top_p must be a number");
  if (topP < 0 || topP > 1) throw new Error("top_p must be between 0 and 1");
}
```

**Step 2: Export from index.ts**

Add to the validation exports in `src/index.ts`:
```typescript
export {
  validateModel,
  validateMaxTokens,
  validateTemperature,
  validateTopP,
  KNOWN_PROVIDERS,
} from "./validation";
```

**Step 3: Commit**

```bash
git add src/validation.ts src/index.ts
git commit -m "feat: add validateModel, validateMaxTokens, validateTemperature, validateTopP"
```

---

### Task 3: Add missing types (CostEstimate, SpendingReport, ChatResponseWithCost, SearchUsage)

Python SDK has these types in `types.py`. TS SDK is missing them.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/index.ts`

**Step 1: Add types to types.ts**

Add after the `Spending` interface:

```typescript
/** Search usage information from Live Search. */
export interface SearchUsage {
  numSourcesUsed?: number;
}

/** Cost estimate from dry-run request. */
export interface CostEstimate {
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
}

/** Spending report returned after each paid call. */
export interface SpendingReport {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionTotalUsd: number;
  sessionCalls: number;
}

/** Chat response with spending report attached. */
export interface ChatResponseWithCost {
  response: ChatResponse;
  spendingReport: SpendingReport;
}
```

**Step 2: Export from index.ts**

Add to the types export block in `src/index.ts`:
```typescript
type SearchUsage,
type CostEstimate,
type SpendingReport,
type ChatResponseWithCost,
```

**Step 3: Commit**

```bash
git add src/types.ts src/index.ts
git commit -m "feat: add SearchUsage, CostEstimate, SpendingReport, ChatResponseWithCost types"
```

---

### Task 4: Upgrade cache to two-layer storage with human-readable archive + cost log

Python SDK saves to both `~/.blockrun/cache/` (hash-keyed) AND `~/.blockrun/data/` (human-readable archive), plus appends to `~/.blockrun/cost_log.jsonl`. TS SDK only has the hash-keyed cache.

**Files:**
- Modify: `src/cache.ts`
- Modify: `src/index.ts`

**Step 1: Add human-readable archive and cost log to cache.ts**

Add `DATA_DIR` and `COST_LOG_FILE` constants. Add `readableFilename()`, `saveReadable()`, `appendCostLog()` helper functions. Add `getCostLogSummary()` export. Update `saveToCache()` to call both layers.

**Step 2: Export getCostLogSummary from index.ts**

```typescript
export { getCached, setCache, clearCache, saveToCache, getCachedByRequest, getCostLogSummary } from "./cache";
```

**Step 3: Commit**

```bash
git add src/cache.ts src/index.ts
git commit -m "feat: add two-layer cache with human-readable archive and cost log"
```

---

### Task 5: Add 502/503 auto-retry to all request methods

Python SDK auto-retries once after 1s delay on 502/503. TS SDK does not retry at all.

**Files:**
- Modify: `src/client.ts`

**Step 1: Add retry logic to requestWithPayment**

After the initial `response` check, before throwing on `!response.ok`, add:

```typescript
// Auto-retry on transient server errors (502/503)
if (response.status === 502 || response.status === 503) {
  await new Promise(r => setTimeout(r, 1000));
  const retryResp = await this.fetchWithTimeout(url, { ...options });
  if (retryResp.status !== 502 && retryResp.status !== 503) {
    // use retryResp instead
  }
}
```

Apply the same pattern to:
- `requestWithPayment` (POST, chat endpoint)
- `requestWithPaymentRaw` (POST, raw endpoints)
- `getWithPaymentRaw` (GET, pm endpoints)
- `handlePaymentAndRetry` (after payment retry)
- `handlePaymentAndRetryRaw` (after payment retry)
- `handleGetPaymentAndRetryRaw` (after GET payment retry)

**Step 2: Verify build**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/client.ts
git commit -m "feat: add 502/503 auto-retry with 1s delay on transient server errors"
```

---

### Task 6: Update all doc references (model names + search wording)

Python SDK v0.10.0 updated `gpt-4o` → `gpt-5.2`, `claude-sonnet-4` → `claude-sonnet-4.6`, and changed "xAI Live Search" / "for Grok models" to generalized wording.

**Files:**
- Modify: `src/client.ts`
- Modify: `src/solana-client.ts`
- Modify: `src/openai-compat.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`

**Step 1: Update model references**

Replace across all files:
- `gpt-4o` → `gpt-5.2` (in doc comments/examples only)
- `claude-sonnet-4` → `claude-sonnet-4.6` (in doc comments/examples only)

**Step 2: Update search wording**

Replace across all files:
- `xAI Live Search` → `Live Search`
- `for Grok models` → `for search-enabled models`

**Step 3: Commit**

```bash
git add src/client.ts src/solana-client.ts src/openai-compat.ts src/index.ts src/types.ts
git commit -m "docs: update model references and search wording to match Python SDK v0.10.0"
```

---

### Task 7: Bump version to 1.5.0

**Files:**
- Modify: `package.json`

**Step 1: Update version**

Change `"version": "1.4.3"` to `"version": "1.5.0"` in `package.json`.

**Step 2: Build and verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump to v1.5.0"
```
