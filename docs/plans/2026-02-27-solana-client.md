# SolanaLLMClient TypeScript SDK Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `SolanaLLMClient` class to `@blockrun/llm` so Solana developers can pay for AI calls with Solana USDC via x402.

**Architecture:** New `SolanaLLMClient` class (mirrors `LLMClient` but uses Solana keypair + `createSolanaPaymentPayload` from x402.ts which already exists). New `solana-wallet.ts` for Solana keypair management. All existing Base/EVM code is untouched. `@solana/web3.js` and `@solana/spl-token` are already optional dependencies.

**Tech Stack:** TypeScript, `@solana/web3.js`, `@solana/spl-token`, `bs58` (already in blockrun-sol), existing `createSolanaPaymentPayload` in `src/x402.ts`

---

### Task 1: Add Solana wallet utilities

**Files:**
- Create: `src/solana-wallet.ts`
- Test: `test/unit/solana-wallet.test.ts`

**Context:** Mirrors `src/wallet.ts` but for Solana. Solana keys are bs58-encoded strings (base58, not hex). Key stored at `~/.blockrun/.solana-session`.

**Step 1: Write failing test**

Create `test/unit/solana-wallet.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createSolanaWallet,
  solanaKeyToBytes,
  getOrCreateSolanaWallet,
} from "../../src/solana-wallet";

const TEST_WALLET_DIR = path.join(os.tmpdir(), `.blockrun-test-${Date.now()}`);
const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

describe("Solana Wallet", () => {
  it("createSolanaWallet returns address and privateKey", () => {
    const wallet = createSolanaWallet();
    expect(wallet.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58
    expect(wallet.privateKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/); // bs58 64-byte key
  });

  it("solanaKeyToBytes converts bs58 key to Uint8Array", async () => {
    const bytes = await solanaKeyToBytes(TEST_BS58_KEY);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(64);
  });

  it("solanaKeyToBytes throws on invalid key", async () => {
    await expect(solanaKeyToBytes("invalid-key")).rejects.toThrow();
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/vickyfu/Documents/blockrun-web/blockrun-llm-ts
pnpm test test/unit/solana-wallet.test.ts
```
Expected: FAIL with "Cannot find module"

**Step 3: Implement `src/solana-wallet.ts`**

```typescript
/**
 * BlockRun Solana Wallet Management.
 * Stores keys as bs58-encoded strings at ~/.blockrun/.solana-session
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const WALLET_DIR = path.join(os.homedir(), ".blockrun");
const SOLANA_WALLET_FILE = path.join(WALLET_DIR, ".solana-session");

export interface SolanaWalletInfo {
  privateKey: string; // bs58-encoded 64-byte secret key
  address: string;    // base58 public key
  isNew: boolean;
}

/**
 * Create a new Solana wallet.
 * Requires @solana/web3.js (optional dep).
 */
export function createSolanaWallet(): { address: string; privateKey: string } {
  // Use dynamic require for optional dep
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require("@solana/web3.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bs58 = require("bs58");
  const keypair = Keypair.generate();
  return {
    address: keypair.publicKey.toBase58(),
    privateKey: bs58.default?.encode(keypair.secretKey) ?? bs58.encode(keypair.secretKey),
  };
}

/**
 * Convert a bs58 private key string to Uint8Array (64 bytes).
 * Accepts: bs58-encoded 64-byte key (standard Solana format).
 */
export async function solanaKeyToBytes(privateKey: string): Promise<Uint8Array> {
  try {
    const bs58 = await import("bs58");
    const bytes = (bs58.default ?? bs58).decode(privateKey);
    if (bytes.length !== 64) {
      throw new Error(`Invalid Solana key length: expected 64 bytes, got ${bytes.length}`);
    }
    return bytes;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid Solana private key: ${msg}`);
  }
}

/**
 * Get Solana public key (address) from bs58 private key.
 */
export async function solanaPublicKey(privateKey: string): Promise<string> {
  const { Keypair } = await import("@solana/web3.js");
  const bytes = await solanaKeyToBytes(privateKey);
  return Keypair.fromSecretKey(bytes).publicKey.toBase58();
}

export function saveSolanaWallet(privateKey: string): string {
  if (!fs.existsSync(WALLET_DIR)) fs.mkdirSync(WALLET_DIR, { recursive: true });
  fs.writeFileSync(SOLANA_WALLET_FILE, privateKey, { mode: 0o600 });
  return SOLANA_WALLET_FILE;
}

export function loadSolanaWallet(): string | null {
  if (fs.existsSync(SOLANA_WALLET_FILE)) {
    const key = fs.readFileSync(SOLANA_WALLET_FILE, "utf-8").trim();
    if (key) return key;
  }
  return null;
}

export async function getOrCreateSolanaWallet(): Promise<SolanaWalletInfo> {
  const envKey = typeof process !== "undefined" && process.env
    ? process.env.SOLANA_WALLET_KEY
    : undefined;
  if (envKey) {
    const address = await solanaPublicKey(envKey);
    return { privateKey: envKey, address, isNew: false };
  }
  const fileKey = loadSolanaWallet();
  if (fileKey) {
    const address = await solanaPublicKey(fileKey);
    return { privateKey: fileKey, address, isNew: false };
  }
  const { address, privateKey } = createSolanaWallet();
  saveSolanaWallet(privateKey);
  return { address, privateKey, isNew: true };
}

export { SOLANA_WALLET_FILE as SOLANA_WALLET_FILE_PATH };
```

**Step 4: Run test to verify pass**

```bash
pnpm test test/unit/solana-wallet.test.ts
```
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/solana-wallet.ts test/unit/solana-wallet.test.ts
git commit -m "feat: add Solana wallet utilities"
```

---

### Task 2: Add SolanaLLMClient

**Files:**
- Create: `src/solana-client.ts`
- Test: `test/unit/solana-client.test.ts`

**Context:** Mirrors `LLMClient` but uses Solana keypair. The 402 response from `sol.blockrun.ai` has `network: "solana:..."`, `extra.feePayer` for the CDP fee payer address. `createSolanaPaymentPayload` in x402.ts already handles the signing. Default API URL is `https://sol.blockrun.ai/api`.

**Step 1: Write failing tests**

Create `test/unit/solana-client.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SolanaLLMClient } from "../../src/solana-client";

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

describe("SolanaLLMClient", () => {
  it("initializes with bs58 private key", () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    expect(client).toBeTruthy();
  });

  it("throws if no private key provided and no env var", () => {
    const savedKey = process.env.SOLANA_WALLET_KEY;
    delete process.env.SOLANA_WALLET_KEY;
    expect(() => new SolanaLLMClient()).toThrow(/private key required/i);
    if (savedKey) process.env.SOLANA_WALLET_KEY = savedKey;
  });

  it("uses sol.blockrun.ai as default API URL", () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    expect(client.isSolana()).toBe(true);
  });

  it("uses custom API URL when provided", () => {
    const client = new SolanaLLMClient({
      privateKey: TEST_BS58_KEY,
      apiUrl: "https://custom.example.com/api",
    });
    expect(client.isSolana()).toBe(false);
  });

  it("reads private key from SOLANA_WALLET_KEY env var", () => {
    process.env.SOLANA_WALLET_KEY = TEST_BS58_KEY;
    const client = new SolanaLLMClient();
    expect(client).toBeTruthy();
    delete process.env.SOLANA_WALLET_KEY;
  });
});
```

**Step 2: Run to verify fails**

```bash
pnpm test test/unit/solana-client.test.ts
```
Expected: FAIL "Cannot find module"

**Step 3: Implement `src/solana-client.ts`**

```typescript
/**
 * BlockRun Solana LLM Client.
 *
 * Usage:
 *   import { SolanaLLMClient } from '@blockrun/llm';
 *
 *   // SOLANA_WALLET_KEY env var (bs58-encoded Solana secret key)
 *   const client = new SolanaLLMClient();
 *
 *   // Or pass key directly
 *   const client = new SolanaLLMClient({ privateKey: 'your-bs58-key' });
 *
 *   const response = await client.chat('openai/gpt-4o', 'gm Solana');
 */
import type {
  ChatMessage,
  ChatResponse,
  ChatOptions,
  ChatCompletionOptions,
  Model,
  Spending,
} from "./types";
import { APIError, PaymentError } from "./types";
import {
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  SOLANA_NETWORK,
} from "./x402";
import { solanaKeyToBytes, solanaPublicKey } from "./solana-wallet";
import { sanitizeErrorResponse, validateApiUrl, validateResourceUrl } from "./validation";

const SOLANA_API_URL = "https://sol.blockrun.ai/api";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT = 60000;
const SDK_VERSION = "0.3.0";
const USER_AGENT = `blockrun-ts/${SDK_VERSION}`;

export interface SolanaLLMClientOptions {
  /** bs58-encoded Solana secret key (64 bytes). Optional if SOLANA_WALLET_KEY env var is set. */
  privateKey?: string;
  /** API endpoint URL (default: https://sol.blockrun.ai/api) */
  apiUrl?: string;
  /** Solana RPC URL (default: https://api.mainnet-beta.solana.com) */
  rpcUrl?: string;
  /** Request timeout in milliseconds (default: 60000) */
  timeout?: number;
}

export class SolanaLLMClient {
  static readonly SOLANA_API_URL = SOLANA_API_URL;

  private privateKey: string;
  private apiUrl: string;
  private rpcUrl: string;
  private timeout: number;
  private sessionTotalUsd = 0;
  private sessionCalls = 0;
  private addressCache: string | null = null;

  constructor(options: SolanaLLMClientOptions = {}) {
    const envKey = typeof process !== "undefined" && process.env
      ? process.env.SOLANA_WALLET_KEY
      : undefined;
    const privateKey = options.privateKey || envKey;

    if (!privateKey) {
      throw new Error(
        "Private key required. Pass privateKey in options or set SOLANA_WALLET_KEY environment variable."
      );
    }

    this.privateKey = privateKey;

    const apiUrl = options.apiUrl || SOLANA_API_URL;
    validateApiUrl(apiUrl);
    this.apiUrl = apiUrl.replace(/\/$/, "");

    this.rpcUrl = options.rpcUrl || "https://api.mainnet-beta.solana.com";
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  /** Get Solana wallet address (public key in base58). */
  async getWalletAddress(): Promise<string> {
    if (!this.addressCache) {
      this.addressCache = await solanaPublicKey(this.privateKey);
    }
    return this.addressCache;
  }

  /** Simple 1-line chat. */
  async chat(model: string, prompt: string, options?: ChatOptions): Promise<string> {
    const messages: ChatMessage[] = [];
    if (options?.system) messages.push({ role: "system", content: options.system });
    messages.push({ role: "user", content: prompt });
    const result = await this.chatCompletion(model, messages, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      topP: options?.topP,
      search: options?.search,
      searchParameters: options?.searchParameters,
    });
    return result.choices[0].message.content || "";
  }

  /** Full chat completion (OpenAI-compatible). */
  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    options?: ChatCompletionOptions
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options?.maxTokens || DEFAULT_MAX_TOKENS,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.topP !== undefined) body.top_p = options.topP;
    if (options?.searchParameters !== undefined) body.search_parameters = options.searchParameters;
    else if (options?.search === true) body.search_parameters = { mode: "on" };
    if (options?.tools !== undefined) body.tools = options.tools;
    if (options?.toolChoice !== undefined) body.tool_choice = options.toolChoice;
    return this.requestWithPayment("/v1/chat/completions", body);
  }

  /** List available models. */
  async listModels(): Promise<Model[]> {
    const response = await this.fetchWithTimeout(`${this.apiUrl}/v1/models`, { method: "GET" });
    if (!response.ok) {
      throw new APIError(`Failed to list models: ${response.status}`, response.status);
    }
    const data = (await response.json()) as { data?: Model[] };
    return data.data || [];
  }

  /** Get session spending. */
  getSpending(): Spending {
    return { totalUsd: this.sessionTotalUsd, calls: this.sessionCalls };
  }

  /** True if using sol.blockrun.ai. */
  isSolana(): boolean {
    return this.apiUrl.includes("sol.blockrun.ai");
  }

  private async requestWithPayment(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<ChatResponse> {
    const url = `${this.apiUrl}${endpoint}`;
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
    });

    if (response.status === 402) {
      return this.handlePaymentAndRetry(url, body, response);
    }

    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
    }

    return response.json() as Promise<ChatResponse>;
  }

  private async handlePaymentAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<ChatResponse> {
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = await response.json() as Record<string, unknown>;
        if (respBody.accepts || respBody.x402Version) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch { /* ignore */ }
    }

    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);

    if (!details.network?.startsWith("solana:")) {
      throw new PaymentError(
        `Expected Solana payment network, got: ${details.network}. Use LLMClient for Base payments.`
      );
    }

    const feePayer = (details.extra as { feePayer?: string })?.feePayer;
    if (!feePayer) throw new PaymentError("Missing feePayer in 402 extra field");

    const fromAddress = await this.getWalletAddress();
    const secretKey = await solanaKeyToBytes(this.privateKey);
    const extensions = ((paymentRequired as unknown) as Record<string, unknown>).extensions as Record<string, unknown> | undefined;

    const paymentPayload = await createSolanaPaymentPayload(
      secretKey,
      fromAddress,
      details.recipient,
      details.amount,
      feePayer,
      {
        resourceUrl: validateResourceUrl(
          details.resource?.url || `${this.apiUrl}/v1/chat/completions`,
          this.apiUrl
        ),
        resourceDescription: details.resource?.description || "BlockRun Solana AI API call",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown>,
        extensions,
        rpcUrl: this.rpcUrl,
      }
    );

    const retryResponse = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "PAYMENT-SIGNATURE": paymentPayload,
      },
      body: JSON.stringify(body),
    });

    if (retryResponse.status === 402) {
      throw new PaymentError("Payment was rejected. Check your Solana USDC balance.");
    }

    if (!retryResponse.ok) {
      let errorBody: unknown;
      try { errorBody = await retryResponse.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error after payment: ${retryResponse.status}`, retryResponse.status, sanitizeErrorResponse(errorBody));
    }

    const costUsd = parseFloat(details.amount) / 1e6;
    this.sessionCalls += 1;
    this.sessionTotalUsd += costUsd;

    return retryResponse.json() as Promise<ChatResponse>;
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Convenience function: create SolanaLLMClient for sol.blockrun.ai.
 */
export function solanaClient(options: SolanaLLMClientOptions = {}): SolanaLLMClient {
  return new SolanaLLMClient({ ...options, apiUrl: SOLANA_API_URL });
}
```

**Step 4: Run tests**

```bash
pnpm test test/unit/solana-client.test.ts
```
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add src/solana-client.ts test/unit/solana-client.test.ts
git commit -m "feat: add SolanaLLMClient for Solana USDC payments"
```

---

### Task 3: Update exports and build

**Files:**
- Modify: `src/index.ts`

**Step 1: Add Solana exports to `src/index.ts`**

After the existing exports, add:

```typescript
// Solana client
export { SolanaLLMClient, solanaClient, type SolanaLLMClientOptions } from "./solana-client";

// Solana wallet utilities
export {
  createSolanaWallet,
  saveSolanaWallet,
  loadSolanaWallet,
  getOrCreateSolanaWallet,
  solanaKeyToBytes,
  solanaPublicKey,
  SOLANA_WALLET_FILE_PATH,
  type SolanaWalletInfo,
} from "./solana-wallet";

// Solana x402 constants
export { SOLANA_NETWORK, USDC_SOLANA, createSolanaPaymentPayload } from "./x402";
```

**Step 2: Typecheck**

```bash
pnpm typecheck
```
Expected: no errors

**Step 3: Build**

```bash
pnpm build
```
Expected: `dist/` updated with no errors

**Step 4: Run all unit tests**

```bash
pnpm test --run
```
Expected: all pass

**Step 5: Commit and version bump**

Update `package.json` version from `1.0.1` → `1.1.0` (minor bump, new feature).

```bash
git add src/index.ts package.json
git commit -m "feat: export SolanaLLMClient and bump to 1.1.0"
```

---

### Task 4: Update README

**Files:**
- Modify: `README.md`

**Step 1: Add Solana section to README**

Find the existing "Supported Chains" or installation section and add after it:

```markdown
## Solana Support

Pay for AI calls with Solana USDC via [sol.blockrun.ai](https://sol.blockrun.ai):

\`\`\`typescript
import { SolanaLLMClient } from '@blockrun/llm';

// SOLANA_WALLET_KEY env var (bs58-encoded Solana secret key)
const client = new SolanaLLMClient();

// Or pass key directly
const client = new SolanaLLMClient({ privateKey: 'your-bs58-solana-key' });

// Same API as LLMClient
const response = await client.chat('openai/gpt-4o', 'gm Solana');
console.log(response);

// Live Search with Grok (Solana payment)
const tweet = await client.chat('xai/grok-3-mini', 'What is trending on X?', { search: true });
\`\`\`

**Setup:**
1. Export your Solana wallet key: `export SOLANA_WALLET_KEY="your-bs58-key"`
2. Fund with USDC on Solana mainnet
3. That's it — payments are automatic via x402

**Supported endpoint:** `https://sol.blockrun.ai/api`
**Payment:** Solana USDC (SPL, mainnet)
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add Solana usage section to README"
```

---

### Task 5: Publish

**Step 1: Publish to npm**

```bash
pnpm publish --access public
```
Expected: `@blockrun/llm@1.1.0` published

**Step 2: Push to GitHub**

```bash
git push
```
