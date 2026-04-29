# @blockrun/llm (TypeScript SDK)

> **@blockrun/llm** is a TypeScript/Node.js SDK for accessing 41+ large language models (GPT-5, Claude, Gemini, Grok, DeepSeek, Kimi, and more) with automatic pay-per-request USDC micropayments via the x402 protocol. No API keys required — your wallet signature is your authentication. Supports **streaming**, smart routing, Base and Solana chains.
>
> 🆓 **Includes 9 fully-free NVIDIA-hosted models** — DeepSeek V4 Pro/Flash (1M context), Nemotron Nano Omni (vision), Qwen3, Llama 4, GLM-4.7, Mistral. Zero USDC, no rate-limit gimmicks. Use `routingProfile: 'free'` or call any `nvidia/*` model directly.

[![npm](https://img.shields.io/npm/v/@blockrun/llm.svg)](https://www.npmjs.com/package/@blockrun/llm)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Supported Chains

| Chain | Network | Payment | Status |
|-------|---------|---------|--------|
| **Base** | Base Mainnet (Chain ID: 8453) | USDC | Primary |
| **Base Testnet** | Base Sepolia (Chain ID: 84532) | Testnet USDC | Development |
| **Solana** | Solana Mainnet | USDC (SPL) | New |

> **XRPL (RLUSD):** Use [@blockrun/llm-xrpl](https://www.npmjs.com/package/@blockrun/llm-xrpl) for XRPL payments

**Protocol:** x402 v2 (CDP Facilitator)

## Installation

```bash
# Base and Solana support (optional Solana deps auto-installed)
npm install @blockrun/llm
# or
pnpm add @blockrun/llm
# or
yarn add @blockrun/llm
```

## Quick Start (Base - Default)

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();  // Uses BASE_CHAIN_WALLET_KEY (never sent to server)
const response = await client.chat('openai/gpt-4o', 'Hello!');
```

That's it. The SDK handles x402 payment automatically.

### Try It Free (No USDC Required)

Want to kick the tires before funding a wallet? Route to BlockRun's free NVIDIA tier:

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();  // Wallet still required for signing, but $0 charged

// Option 1: call a free model directly
const reply = await client.chat('nvidia/qwen3-next-80b-a3b-thinking', 'Explain x402 in 1 sentence');

// Option 2: let the smart router pick the best free model per request
const result = await client.smartChat('What is 2+2?', { routingProfile: 'free' });
console.log(result.model);     // e.g. 'nvidia/deepseek-v4-flash' (cheapest capable for SIMPLE tier)
console.log(result.response);  // '4'
```

**Available free models** (input + output both $0, all NVIDIA-hosted, last refreshed 2026-04-28):

| Model ID | Context | Best For |
|----------|---------|----------|
| `nvidia/deepseek-v4-pro` | 1M | Flagship reasoning — MMLU-Pro 87.5, GPQA 90.1, SWE-bench 80.6, LiveCodeBench 93.5 |
| `nvidia/deepseek-v4-flash` | 1M | ~5× faster than V4 Pro — chat, summarization, light reasoning (weaker factual recall) |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | 256K | Only vision-capable free model — text + images + video (≤2 min) + audio (≤1 hr) |
| `nvidia/qwen3-next-80b-a3b-thinking` | 131K | 116 tok/s reasoning with thinking mode |
| `nvidia/mistral-small-4-119b` | 131K | 114 tok/s — fastest free chat |
| `nvidia/glm-4.7` | 131K | 237 tok/s — GLM-4.7 with thinking mode |
| `nvidia/llama-4-maverick` | 131K | Meta Llama 4 Maverick MoE |
| `nvidia/qwen3-coder-480b` | 131K | Coding-optimised 480B MoE |
| `nvidia/deepseek-v3.2` | 131K | Legacy V3.2 — auto-upgrades to V4 Pro via fallback |

> Note: `nvidia/gpt-oss-120b` and `nvidia/gpt-oss-20b` were retired 2026-04-28 — NVIDIA's free build.nvidia.com tier reserves the right to use prompts/outputs for service improvement, which conflicts with our data-privacy policy.

## Quick Start (Solana)

```typescript
import { SolanaLLMClient } from '@blockrun/llm';

// SOLANA_WALLET_KEY env var (bs58-encoded Solana secret key)
const client = new SolanaLLMClient();
const response = await client.chat('openai/gpt-4o', 'gm Solana');
console.log(response);
```

Set `SOLANA_WALLET_KEY` to your bs58-encoded Solana secret key. Payments are automatic via x402 — your key never leaves your machine.

## Solana Support

Pay for AI calls with Solana USDC via [sol.blockrun.ai](https://sol.blockrun.ai):

```typescript
import { SolanaLLMClient } from '@blockrun/llm';

// SOLANA_WALLET_KEY env var (bs58-encoded Solana secret key)
const client = new SolanaLLMClient();

// Or pass key directly
const client2 = new SolanaLLMClient({ privateKey: 'your-bs58-solana-key' });

// Same API as LLMClient
const response = await client.chat('openai/gpt-4o', 'gm Solana');
console.log(response);

// Live Search with Grok (Solana payment)
const tweet = await client.chat('xai/grok-3-mini', 'What is trending on X?', { search: true });
```

**Setup:**
1. Export your Solana wallet key: `export SOLANA_WALLET_KEY="your-bs58-key"`
2. Fund with USDC on Solana mainnet
3. That's it — payments are automatic via x402

**Supported endpoint:** `https://sol.blockrun.ai/api`
**Payment:** Solana USDC (SPL, mainnet)

## How It Works

1. You send a request to BlockRun's API
2. The API returns a 402 Payment Required with the price
3. The SDK automatically signs a USDC payment on Base
4. The request is retried with the payment proof
5. You receive the AI response

**Your private key never leaves your machine** - it's only used for local signing.

## Smart Routing (ClawRouter)

Let the SDK automatically pick the cheapest capable model for each request:

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();

// Auto-routes to cheapest capable model
const result = await client.smartChat('What is 2+2?');
console.log(result.response);     // '4'
console.log(result.model);        // 'moonshot/kimi-k2.5' (cheap, fast)
console.log(`Saved ${(result.routing.savings * 100).toFixed(0)}%`); // 'Saved 78%'

// Complex reasoning task -> routes to reasoning model
const complex = await client.smartChat('Prove the Riemann hypothesis step by step');
console.log(complex.model);  // 'xai/grok-4-1-fast-reasoning'
```

### Routing Profiles

| Profile | Description | Best For |
|---------|-------------|----------|
| `free` | NVIDIA free tier — smart-routes across 9 models (DeepSeek V4 Pro/Flash, Nemotron Nano Omni, Qwen3, GLM-4.7, Llama 4, Mistral) | Zero-cost testing, dev, prod |
| `eco` | Cheapest models per tier (DeepSeek, xAI) | Cost-sensitive production |
| `auto` | Best balance of cost/quality (default) | General use |
| `premium` | Top-tier models (OpenAI, Anthropic) | Quality-critical tasks |

```typescript
// Use premium models for complex tasks
const result = await client.smartChat(
  'Write production-grade async TypeScript code',
  { routingProfile: 'premium' }
);
console.log(result.model);  // 'anthropic/claude-opus-4.5'
```

### How ClawRouter Works

ClawRouter uses a 14-dimension rule-based classifier to analyze each request:

- **Token count** - Short vs long prompts
- **Code presence** - Programming keywords
- **Reasoning markers** - "prove", "step by step", etc.
- **Technical terms** - Architecture, optimization, etc.
- **Creative markers** - Story, poem, brainstorm, etc.
- **Agentic patterns** - Multi-step, tool use indicators

The classifier runs in <1ms, 100% locally, and routes to one of four tiers:

| Tier | Example Tasks | Auto Profile Model |
|------|---------------|-------------------|
| SIMPLE | "What is 2+2?", definitions | moonshot/kimi-k2.5 |
| MEDIUM | Code snippets, explanations | xai/grok-code-fast-1 |
| COMPLEX | Architecture, long documents | google/gemini-3.1-pro |
| REASONING | Proofs, multi-step reasoning | xai/grok-4-1-fast-reasoning |

## Available Models

### OpenAI GPT-5.5 Family
Released 2026-04-23 — first fully retrained base since GPT-4.5. 1M context, 128K output, native agent + computer use.

| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `openai/gpt-5.5` | $5.00/M | $30.00/M |

### OpenAI GPT-5.4 Family
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `openai/gpt-5.4` | $2.50/M | $15.00/M |
| `openai/gpt-5.4-pro` | $30.00/M | $180.00/M |
| `openai/gpt-5.4-nano` | $0.20/M | $1.25/M |

### OpenAI GPT-5 Family
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `openai/gpt-5.3` | $1.75/M | $14.00/M |
| `openai/gpt-5.2` | $1.75/M | $14.00/M |
| `openai/gpt-5-mini` | $0.25/M | $2.00/M |
| `openai/gpt-5.2-pro` | $21.00/M | $168.00/M |
| `openai/gpt-5.2-codex` | $1.75/M | $14.00/M |

### OpenAI GPT-4 Family
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `openai/gpt-4.1` | $2.00/M | $8.00/M |
| `openai/gpt-4.1-mini` | $0.40/M | $1.60/M |
| `openai/gpt-4.1-nano` | $0.10/M | $0.40/M |
| `openai/gpt-4o` | $2.50/M | $10.00/M |
| `openai/gpt-4o-mini` | $0.15/M | $0.60/M |

### OpenAI O-Series (Reasoning)
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `openai/o1` | $15.00/M | $60.00/M |
| `openai/o1-mini` | $1.10/M | $4.40/M |
| `openai/o3` | $2.00/M | $8.00/M |
| `openai/o3-mini` | $1.10/M | $4.40/M |
| `openai/o4-mini` | $1.10/M | $4.40/M |

### Anthropic Claude
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `anthropic/claude-opus-4.6` | $5.00/M | $25.00/M |
| `anthropic/claude-opus-4.5` | $5.00/M | $25.00/M |
| `anthropic/claude-opus-4` | $15.00/M | $75.00/M |
| `anthropic/claude-sonnet-4.6` | $3.00/M | $15.00/M |
| `anthropic/claude-sonnet-4` | $3.00/M | $15.00/M |
| `anthropic/claude-haiku-4.5` | $1.00/M | $5.00/M |

### Google Gemini
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `google/gemini-3.1-pro` | $2.00/M | $12.00/M |
| `google/gemini-3.1-flash-lite` | $0.25/M | $1.50/M |
| `google/gemini-3-flash-preview` | $0.50/M | $3.00/M |
| `google/gemini-2.5-pro` | $1.25/M | $10.00/M |
| `google/gemini-2.5-flash` | $0.30/M | $2.50/M |
| `google/gemini-2.5-flash-lite` | $0.10/M | $0.40/M |

### DeepSeek
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `deepseek/deepseek-chat` | $0.28/M | $0.42/M |
| `deepseek/deepseek-reasoner` | $0.28/M | $0.42/M |

### xAI Grok
| Model | Input Price | Output Price | Context | Notes |
|-------|-------------|--------------|---------|-------|
| `xai/grok-3` | $3.00/M | $15.00/M | 131K | Flagship |
| `xai/grok-3-mini` | $0.30/M | $0.50/M | 131K | Fast & affordable |
| `xai/grok-4-1-fast-reasoning` | $0.20/M | $0.50/M | **2M** | Latest, chain-of-thought |
| `xai/grok-4-1-fast-non-reasoning` | $0.20/M | $0.50/M | **2M** | Latest, direct response |
| `xai/grok-4-fast-reasoning` | $0.20/M | $0.50/M | **2M** | Step-by-step reasoning |
| `xai/grok-4-fast-non-reasoning` | $0.20/M | $0.50/M | **2M** | Quick responses |
| `xai/grok-code-fast-1` | $0.20/M | $1.50/M | 256K | Code generation |
| `xai/grok-4-0709` | $0.20/M | $1.50/M | 256K | Premium quality |
| `xai/grok-2-vision` | $2.00/M | $10.00/M | 32K | Vision capabilities |

### Moonshot Kimi
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `moonshot/kimi-k2.6` | $0.95/M | $4.00/M |
| `moonshot/kimi-k2.5` | $0.60/M | $3.00/M |

### MiniMax
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `minimax/minimax-m2.7` | $0.30/M | $1.20/M |
| `minimax/minimax-m2.5` | $0.30/M | $1.20/M |

### NVIDIA (Free) + Moonshot

Free tier refreshed 2026-04-28: added DeepSeek V4 Pro/Flash and Nemotron Nano
Omni (vision); retired `nvidia/gpt-oss-120b` / `nvidia/gpt-oss-20b` over data
privacy (NVIDIA's free build.nvidia.com tier reserves the right to use prompts
for service improvement, which conflicts with our policy). Backend
auto-redirects retired IDs to the replacements below.

| Model | Input Price | Output Price | Notes |
|-------|-------------|--------------|-------|
| `nvidia/deepseek-v4-pro` | **FREE** | **FREE** | 1.6T MoE / 49B active, 1M context — flagship reasoning (MMLU-Pro 87.5, GPQA 90.1) |
| `nvidia/deepseek-v4-flash` | **FREE** | **FREE** | 284B / 13B active MoE, 1M context — ~5× faster than V4 Pro |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | **FREE** | **FREE** | 31B / 3.2B active MoE, 256K — only vision-capable free model |
| `nvidia/qwen3-next-80b-a3b-thinking` | **FREE** | **FREE** | 116 tok/s — reasoning flagship with thinking mode |
| `nvidia/mistral-small-4-119b` | **FREE** | **FREE** | 114 tok/s — fastest free chat |
| `nvidia/glm-4.7` | **FREE** | **FREE** | 237 tok/s — GLM-4.7 with thinking mode |
| `nvidia/llama-4-maverick` | **FREE** | **FREE** | Meta Llama 4 Maverick MoE |
| `nvidia/qwen3-coder-480b` | **FREE** | **FREE** | Coding-optimised 480B MoE |
| `nvidia/deepseek-v3.2` | **FREE** | **FREE** | Legacy V3.2 — auto-upgrades to V4 Pro via fallback |
| `moonshot/kimi-k2.5` | $0.60/M | $3.00/M | Direct from Moonshot — replaces `nvidia/kimi-k2.5` |

### E2E Verified Models

All models below have been tested end-to-end via the TypeScript SDK (Feb 2026):

| Provider | Model | Status |
|----------|-------|--------|
| OpenAI | `openai/gpt-4o-mini` | Passed |
| OpenAI | `openai/gpt-5.2-codex` | Passed |
| Anthropic | `anthropic/claude-opus-4.6` | Passed |
| Anthropic | `anthropic/claude-sonnet-4` | Passed |
| Google | `google/gemini-2.5-flash` | Passed |
| DeepSeek | `deepseek/deepseek-chat` | Passed |
| xAI | `xai/grok-3` | Passed |
| Moonshot | `moonshot/kimi-k2.6` | Passed |

### Image Generation
| Model | Price |
|-------|-------|
| `openai/dall-e-3` | $0.04-0.08/image |
| `openai/gpt-image-1` | $0.02-0.04/image |
| `openai/gpt-image-2` | $0.06-0.12/image (reasoning-driven, multilingual text rendering, character consistency) |
| `google/nano-banana` | $0.05/image |
| `google/nano-banana-pro` | $0.10-0.15/image |
| `black-forest/flux-1.1-pro` | $0.04/image |
| `xai/grok-imagine-image` | $0.02/image |
| `xai/grok-imagine-image-pro` | $0.07/image |
| `zai/cogview-4` | $0.015/image |

Image editing (`client.edit`): `openai/gpt-image-1` and `openai/gpt-image-2` both support the `/v1/images/image2image` endpoint.

### Video Generation
| Model | Price |
|-------|-------|
| `xai/grok-imagine-video` | $0.05/sec (8s default → $0.42/clip) |
| `bytedance/seedance-1.5-pro` | $0.03/sec (5s default, up to 10s, 720p) |
| `bytedance/seedance-2.0-fast` | $0.15/sec (~60-80s gen, sweet-spot price/quality) |
| `bytedance/seedance-2.0` | $0.30/sec (720p Pro) |

```ts
import { VideoClient } from '@blockrun/llm';

const client = new VideoClient();
const result = await client.generate('a red apple slowly spinning on a wooden table');
console.log(result.data[0].url);             // permanent MP4 URL
console.log(result.data[0].duration_seconds); // 8

// Image-to-video
const r2 = await client.generate('the subject turns and smiles', {
  imageUrl: 'https://example.com/portrait.jpg',
});
```

### Standalone Search

`SearchClient` wraps `POST /v1/search` — standalone Grok Live Search.
Pricing: `$0.025/source + margin` (10 sources ≈ `$0.26`).

```ts
import { SearchClient } from '@blockrun/llm';

const client = new SearchClient();
const result = await client.search('Latest news on x402 adoption', {
  sources: ['x', 'web'],
  maxResults: 10,
});
console.log(result.summary);
for (const url of result.citations ?? []) console.log(url);
```

### X/Twitter (AttentionVC)

`XClient` covers the full `/v1/x/*` endpoint family — previously the `X*`
types were exported but there was no client to call them with.

```ts
import { XClient } from '@blockrun/llm';

const x = new XClient();
const info = await x.userInfo('elonmusk');
const followers = await x.followers('paulg');
const results = await x.search('x402 micropayments', { queryType: 'Latest' });
const tweets = await x.userTweets({ username: 'vitalikbuterin', includeReplies: false });
```

Methods: `userLookup`, `userInfo`, `followers`, `following`, `followings`,
`verifiedFollowers`, `userTweets`, `mentions`, `tweetLookup`, `tweetReplies`,
`tweetThread`, `search`, `trending`, `articlesRising`.

### Market Data (Pyth)

`PriceClient` wraps the Pyth-backed market-data endpoints. Crypto, FX and
commodity are fully free (price + history + list); 12 global stock markets
and the `usstock` legacy alias charge `$0.001` for price + history (list is
always free). Pass `requireWallet: false` to construct a free-only client.

```ts
import { PriceClient } from '@blockrun/llm';

const p = new PriceClient({ requireWallet: false });
const btc = await p.price('crypto', 'BTC-USD');
const eur = await p.price('fx', 'EUR-USD');

// Paid — requires a wallet
const p2 = new PriceClient();
const aapl = await p2.price('stocks', 'AAPL', { market: 'us' });
const bars = await p2.history('stocks', 'AAPL', {
  market: 'us',
  resolution: 'D',
  from: 1700000000,
  to: 1710000000,
});
const symbols = await p.listSymbols('crypto', { query: 'sol', limit: 20 });
```

Supported `StockMarket` values: `us, hk, jp, kr, gb, de, fr, nl, ie, lu, cn, ca`.

### Testnet Models (Base Sepolia)
| Model | Price |
|-------|-------|
| `openai/gpt-oss-20b` | $0.001/request |
| `openai/gpt-oss-120b` | $0.002/request |

*Testnet models use flat pricing (no token counting) for simplicity.*

## X/Twitter Data (Powered by AttentionVC)

Access X/Twitter user profiles, followers, and followings via [AttentionVC](https://attentionvc.ai) partner API. No API keys needed — pay-per-request via x402.

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();

// Look up user profiles ($0.002/user, min $0.02)
const users = await client.xUserLookup(['elonmusk', 'blockaborr']);
for (const user of users.users) {
  console.log(`@${user.userName}: ${user.followers} followers`);
}

// Get followers ($0.05/page, ~200 accounts)
let result = await client.xFollowers('blockaborr');
for (const f of result.followers) {
  console.log(`  @${f.screen_name}`);
}

// Paginate through all followers
while (result.has_next_page) {
  result = await client.xFollowers('blockaborr', result.next_cursor);
}

// Get followings ($0.05/page)
const followings = await client.xFollowings('blockaborr');
```

Works on both `LLMClient` (Base) and `SolanaLLMClient`.

## Standalone Search

Search web, X/Twitter, and news without using a chat model:

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();

const result = await client.search('latest AI agent frameworks 2026');
console.log(result.summary);
for (const cite of result.citations ?? []) {
  console.log(`  - ${cite}`);
}

// Filter by source type and date range
const filtered = await client.search('BlockRun x402', {
  sources: ['web', 'x'],
  fromDate: '2026-01-01',
  maxResults: 5,
});
```

## Image Editing (img2img)

Edit existing images with text prompts:

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();

const result = await client.imageEdit(
  'Make the sky purple and add northern lights',
  'data:image/png;base64,...',  // base64 or URL
  { model: 'openai/gpt-image-1' }
);
console.log(result.data[0].url);
```

## Testnet Usage

For development and testing without real USDC, use the testnet:

```typescript
import { testnetClient } from '@blockrun/llm';

// Create testnet client (uses Base Sepolia)
const client = testnetClient({ privateKey: '0x...' });

// Chat with testnet model
const response = await client.chat('openai/gpt-oss-20b', 'Hello!');
console.log(response);

// Check if client is on testnet
console.log(client.isTestnet()); // true
```

### Testnet Setup

1. Get testnet ETH from [Alchemy Base Sepolia Faucet](https://www.alchemy.com/faucets/base-sepolia)
2. Get testnet USDC from [Circle USDC Faucet](https://faucet.circle.com/)
3. Set your wallet key: `export BASE_CHAIN_WALLET_KEY=0x...`

### Available Testnet Models

- `openai/gpt-oss-20b` - $0.001/request (flat price)
- `openai/gpt-oss-120b` - $0.002/request (flat price)

### Manual Testnet Configuration

```typescript
import { LLMClient } from '@blockrun/llm';

// Or configure manually
const client = new LLMClient({
  privateKey: '0x...',
  apiUrl: 'https://testnet.blockrun.ai/api'
});
const response = await client.chat('openai/gpt-oss-20b', 'Hello!');
```

## Usage Examples

### Simple Chat

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();  // Uses BASE_CHAIN_WALLET_KEY (never sent to server)

const response = await client.chat('openai/gpt-4o', 'Explain quantum computing');
console.log(response);

// With system prompt
const response2 = await client.chat('anthropic/claude-sonnet-4', 'Write a haiku', {
  system: 'You are a creative poet.',
});
```

### Smart Routing (ClawRouter)

Save up to 78% on inference costs with intelligent model routing. ClawRouter uses a 14-dimension rule-based scoring algorithm to select the cheapest model that can handle your request (<1ms, 100% local).

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();

// Auto-route to cheapest capable model
const result = await client.smartChat('What is 2+2?');
console.log(result.response);     // '4'
console.log(result.model);        // 'google/gemini-2.5-flash'
console.log(result.routing.tier); // 'SIMPLE'
console.log(`Saved ${(result.routing.savings * 100).toFixed(0)}%`); // 'Saved 78%'

// Routing profiles
const free = await client.smartChat('Hello!', { routingProfile: 'free' });     // Zero cost
const eco = await client.smartChat('Explain AI', { routingProfile: 'eco' });   // Budget optimized
const auto = await client.smartChat('Code review', { routingProfile: 'auto' }); // Balanced (default)
const premium = await client.smartChat('Write a legal brief', { routingProfile: 'premium' }); // Best quality
```

**Routing Profiles:**

| Profile | Description | Best For |
|---------|-------------|----------|
| `free` | NVIDIA free tier (9 models, smart-routed) | Zero-cost testing, dev, prod |
| `eco` | Budget-optimized | Cost-sensitive workloads |
| `auto` | Intelligent routing (default) | General use |
| `premium` | Best quality models | Critical tasks |

**Tiers:**

| Tier | Example Tasks | Typical Models |
|------|---------------|----------------|
| SIMPLE | Greetings, math, lookups | Gemini Flash, GPT-4o-mini |
| MEDIUM | Explanations, summaries | GPT-4o, Claude Sonnet |
| COMPLEX | Analysis, code generation | GPT-5.2, Claude Opus |
| REASONING | Multi-step logic, planning | o3, DeepSeek Reasoner |

### Full Chat Completion

```typescript
import { LLMClient, type ChatMessage } from '@blockrun/llm';

const client = new LLMClient();  // Uses BASE_CHAIN_WALLET_KEY (never sent to server)

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'How do I read a file in Node.js?' },
];

const result = await client.chatCompletion('openai/gpt-4o', messages);
console.log(result.choices[0].message.content);
```

### Streaming

Stream responses token-by-token with automatic x402 payment. Uses a **pre-auth cache** to skip the 402 round-trip on repeat calls to the same model (~200ms saved per request after the first).

#### OpenAI-compatible (recommended)

```typescript
import { OpenAI } from '@blockrun/llm';

const client = new OpenAI({ walletKey: process.env.BASE_CHAIN_WALLET_KEY });

const stream = await client.chat.completions.create({
  model: 'openai/gpt-5.4',
  messages: [{ role: 'user', content: 'Write a short story about AI agents' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

#### Native client

```typescript
import { LLMClient, type ChatMessage } from '@blockrun/llm';

const client = new LLMClient();

const messages: ChatMessage[] = [
  { role: 'user', content: 'Explain quantum computing in simple terms' },
];

// Returns a raw fetch Response with SSE body
const response = await client.chatCompletionStream('google/gemini-2.5-flash', messages);

const reader = response.body!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value, { stream: true });
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const data = JSON.parse(line.slice(6));
    process.stdout.write(data.choices?.[0]?.delta?.content || '');
  }
}
```

#### Payment + streaming flow

```
First call (cache miss):
  1. Send request → 402 response (BlockRun returns price)
  2. Sign USDC payment locally (key never leaves machine)
  3. Retry with PAYMENT-SIGNATURE header + stream: true
  4. Cache payment requirements for this model (1h TTL)
  5. Stream tokens as they arrive

Subsequent calls (cache hit):
  1. Pre-sign payment from cache — skip 402 round-trip
  2. Send request with PAYMENT-SIGNATURE upfront
  3. Stream tokens immediately (~200ms faster)
```

### List Available Models

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();  // Uses BASE_CHAIN_WALLET_KEY (never sent to server)
const models = await client.listModels();

for (const model of models) {
  console.log(`${model.id}: $${model.inputPrice}/M input`);
}
```

### Multiple Requests

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();  // Uses BASE_CHAIN_WALLET_KEY (never sent to server)

const [gpt, claude, gemini] = await Promise.all([
  client.chat('openai/gpt-4o', 'What is 2+2?'),
  client.chat('anthropic/claude-sonnet-4', 'What is 3+3?'),
  client.chat('google/gemini-2.5-flash', 'What is 4+4?'),
]);
```

## Prediction Markets (Powered by Predexon)

Access real-time prediction market data from Polymarket, Kalshi, and Binance Futures via [Predexon](https://predexon.com). No API keys needed — pay-per-request via x402.

### Polymarket

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();

// List markets with optional filters ($0.001/request)
const markets = await client.pm("polymarket/markets");
const filtered = await client.pm("polymarket/markets", { status: "active", limit: 10 });
const searched = await client.pm("polymarket/markets", { search: "bitcoin" });

// List events ($0.001/request)
const events = await client.pm("polymarket/events");

// Historical trades ($0.001/request)
const trades = await client.pm("polymarket/trades");

// OHLCV candlestick data for a specific condition ($0.001/request)
const candles = await client.pm("polymarket/candlesticks/0x1234abcd...");

// Wallet profile ($0.005/request — tier 2)
const profile = await client.pm("polymarket/wallet/0xABC123...");

// Wallet P&L ($0.005/request — tier 2)
const pnl = await client.pm("polymarket/wallet/pnl/0xABC123...");

// Global leaderboard ($0.001/request)
const leaderboard = await client.pm("polymarket/leaderboard");
```

### Kalshi & Binance

```typescript
// Kalshi markets ($0.001/request)
const kalshiMarkets = await client.pm("kalshi/markets");

// Kalshi trades ($0.001/request)
const kalshiTrades = await client.pm("kalshi/trades");

// Binance candles for supported pairs ($0.001/request)
const btcCandles = await client.pm("binance/candles/BTCUSDT");
const ethCandles = await client.pm("binance/candles/ETHUSDT");
// Also: SOLUSDT, XRPUSDT
```

### Cross-Platform

```typescript
// Cross-platform matching pairs ($0.001/request)
const pairs = await client.pm("matching-markets/pairs");
```

All current endpoints are GET. The `pmQuery()` method is available for future POST endpoints.

Works on both `LLMClient` (Base) and `SolanaLLMClient`.

## Exa Web Search (Powered by Exa)

Access [Exa](https://exa.ai)'s neural web search via x402. No API keys needed — pay-per-request via Solana USDC. Available on `SolanaLLMClient` only.

| Method | Description | Price |
|---|---|---|
| `exaSearch(query, options?)` | Neural/keyword web search | $0.01/request |
| `exaFindSimilar(url, options?)` | Find semantically similar pages | $0.01/request |
| `exaContents(urls, options?)` | Extract full text from URLs | $0.002/URL |
| `exaAnswer(query, options?)` | AI answer grounded in web search | $0.01/request |
| `exa(path, body)` | Generic proxy for any Exa endpoint | varies |

```typescript
import { SolanaLLMClient } from '@blockrun/llm';

const client = new SolanaLLMClient();

// Neural web search ($0.01/request)
const results = await client.exaSearch("latest AI safety research", { numResults: 5 });
const news = await client.exaSearch("bitcoin ETF news", { category: "news", numResults: 10 });

// Find similar pages ($0.01/request)
const similar = await client.exaFindSimilar("https://openai.com/research/gpt-4", { numResults: 5 });

// Extract content from URLs ($0.002/URL)
const content = await client.exaContents(["https://arxiv.org/abs/2303.08774"]);
const rich = await client.exaContents(
  ["https://example.com/page1", "https://example.com/page2"],
  { text: true, highlights: true }
);

// AI-generated answer from live web ($0.01/request)
const answer = await client.exaAnswer("What is the current state of AI safety research?");

// Generic proxy for any Exa endpoint
const custom = await client.exa("search", { query: "transformer architecture", numResults: 5 });
```

`SolanaLLMClient` only — Exa endpoints are on `sol.blockrun.ai`.

## Configuration

```typescript
// Default: reads BASE_CHAIN_WALLET_KEY from environment
const client = new LLMClient();

// Or pass options explicitly
const client = new LLMClient({
  privateKey: '0x...',           // Your wallet key (never sent to server)
  apiUrl: 'https://blockrun.ai/api',   // Optional
  timeout: 60000,                // Optional (ms)
});
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BASE_CHAIN_WALLET_KEY` | Your Base chain wallet private key (for Base / `LLMClient`) |
| `SOLANA_WALLET_KEY` | Your Solana wallet secret key - bs58 encoded (for `SolanaLLMClient`) |
| `BLOCKRUN_API_URL` | API endpoint (optional, default: https://blockrun.ai/api) |

## Error Handling

```typescript
import { LLMClient, APIError, PaymentError } from '@blockrun/llm';

const client = new LLMClient();

try {
  const response = await client.chat('openai/gpt-4o', 'Hello!');
} catch (error) {
  if (error instanceof PaymentError) {
    console.error('Payment failed - check USDC balance');
  } else if (error instanceof APIError) {
    console.error(`API error: ${error.message}`);
  }
}
```

## Testing

### Running Unit Tests

Unit tests do not require API access or funded wallets:

```bash
npm test                          # Run tests in watch mode
npm test run                      # Run tests once
npm test -- --coverage            # Run with coverage report
```

### Running Integration Tests

Integration tests call the production API and require:
- A funded Base wallet with USDC ($1+ recommended)
- `BASE_CHAIN_WALLET_KEY` environment variable set
- Estimated cost: ~$0.05 per test run

```bash
export BASE_CHAIN_WALLET_KEY=0x...
npm test -- test/integration       # Run integration tests only
```

Integration tests are automatically skipped if `BASE_CHAIN_WALLET_KEY` is not set.

## Setting Up Your Wallet

### Base (EVM)
1. Create a wallet on Base (Coinbase Wallet, MetaMask, etc.)
2. Get USDC on Base for API payments
3. Export your private key and set as `BASE_CHAIN_WALLET_KEY`

```bash
# .env
BASE_CHAIN_WALLET_KEY=0x...
```

### Solana
1. Create a Solana wallet (Phantom, Backpack, Solflare, etc.)
2. Get USDC on Solana for API payments
3. Export your secret key and set as `SOLANA_WALLET_KEY`

```bash
# .env
SOLANA_WALLET_KEY=...your_bs58_secret_key
```

Note: Solana transactions are gasless for the user - the CDP facilitator pays for transaction fees.

## Security

### Private Key Safety

- **Private key stays local**: Your key is only used for signing on your machine
- **No custody**: BlockRun never holds your funds
- **Verify transactions**: All payments are on-chain and verifiable

### Best Practices

**Private Key Management:**
- Use environment variables, never hard-code keys
- Use dedicated wallets for API payments (separate from main holdings)
- Set spending limits by only funding payment wallets with small amounts
- Never commit `.env` files to version control
- Rotate keys periodically

**Input Validation:**
The SDK validates all inputs before API requests:
- Private keys (format, length, valid hex)
- API URLs (HTTPS required for production, HTTP allowed for localhost)
- Model names and parameters (ranges for max\_tokens, temperature, top\_p)

**Error Sanitization:**
API errors are automatically sanitized to prevent sensitive information leaks.

**Monitoring:**
```typescript
const address = client.getWalletAddress();
console.log(`View transactions: https://basescan.org/address/${address}`);
```

**Keep Updated:**
```bash
npm update @blockrun/llm  # Get security patches
```

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import {
  LLMClient,
  OpenAI,
  testnetClient,
  type ChatMessage,
  type ChatResponse,
  type ChatOptions,
  type ChatCompletionOptions,
  type Model,
  // Smart routing types
  type SmartChatOptions,
  type SmartChatResponse,
  type RoutingDecision,
  type RoutingProfile,
  type RoutingTier,
  APIError,
  PaymentError,
} from '@blockrun/llm';

// chatCompletionStream returns a standard fetch Response with SSE body
const streamResponse: Response = await client.chatCompletionStream(model, messages, options);

// OpenAI-compat stream returns AsyncIterable
const stream: AsyncIterable<OpenAIChatCompletionChunk> = await openaiClient.chat.completions.create({
  model, messages, stream: true
});
```

## Agent Wallet Setup

One-line setup for agent runtimes (Claude Code skills, MCP servers, etc.):

```typescript
import { setupAgentWallet } from '@blockrun/llm';

// Auto-creates wallet if none exists, returns ready client
const client = setupAgentWallet();
const response = await client.chat('openai/gpt-5.4', 'Hello!');
```

For Solana:

```typescript
import { setupAgentSolanaWallet } from '@blockrun/llm';

const client = await setupAgentSolanaWallet();
const response = await client.chat('anthropic/claude-sonnet-4.6', 'Hello!');
```

Check wallet status:

```typescript
import { status } from '@blockrun/llm';

await status();
// Wallet: 0xCC8c...5EF8
// Balance: $5.30 USDC
```

## Wallet Scanning

The SDK auto-detects wallets from any provider on your system:

```typescript
import { scanWallets, scanSolanaWallets } from '@blockrun/llm';

// Scans ~/.<dir>/wallet.json for Base wallets
const baseWallets = scanWallets();

// Scans ~/.<dir>/solana-wallet.json and ~/.brcc/wallet.json
const solWallets = scanSolanaWallets();
```

`getOrCreateWallet()` checks scanned wallets first, so if you already have a wallet from another BlockRun tool, it will be reused automatically.

## Response Caching

The SDK caches responses to avoid duplicate payments:

```typescript
import { getCachedByRequest, saveToCache, clearCache } from '@blockrun/llm';

// Automatic TTLs by endpoint:
// - X/Twitter: 1 hour
// - Search: 15 minutes
// - Models: 24 hours
// - Chat/Image: no cache (every call is unique)

// Manual cache management
clearCache(); // Remove all cached responses
```

## Cost Logging

Track spending across sessions:

```typescript
import { logCost, getCostSummary } from '@blockrun/llm';

// Costs are logged to ~/.blockrun/data/costs.jsonl
const summary = getCostSummary();
console.log(`Total: $${summary.totalUsd.toFixed(2)}`);
console.log(`Calls: ${summary.calls}`);
console.log(`By model:`, summary.byModel);
```

## Anthropic SDK Compatibility

Use the official Anthropic SDK interface with BlockRun's pay-per-request backend:

```typescript
import { AnthropicClient } from '@blockrun/llm';

const client = new AnthropicClient();  // Auto-detects wallet, auto-pays

const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(response.content[0].text);

// Any model works in Anthropic format
const gptResponse = await client.messages.create({
  model: 'openai/gpt-5.4',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello from GPT!' }],
});
```

The `AnthropicClient` wraps the official `@anthropic-ai/sdk` with a custom fetch that handles x402 payment automatically. Your private key never leaves your machine.

## Links

- [Website](https://blockrun.ai)
- [Documentation](https://github.com/BlockRunAI/awesome-blockrun/tree/main/docs)
- [GitHub](https://github.com/blockrunai/blockrun-llm-ts)
- [Telegram](https://t.me/+mroQv4-4hGgzOGUx)

## Frequently Asked Questions

### What is @blockrun/llm?
@blockrun/llm is a TypeScript SDK that provides pay-per-request access to 40+ large language models from OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot, and more. It uses the x402 protocol for automatic USDC micropayments — no API keys, no subscriptions, no vendor lock-in.

### How does payment work?
When you make an API call, the SDK automatically handles x402 payment. It signs a USDC transaction locally using your wallet private key (which never leaves your machine), and includes the payment proof in the request header. Settlement is non-custodial and instant on Base or Solana.

### What is smart routing / ClawRouter?
ClawRouter is a built-in smart routing engine that analyzes your request across 14 dimensions and automatically picks the cheapest model capable of handling it. Routing happens locally in under 1ms. It can save up to 78% on LLM costs compared to using premium models for every request.

### Does it support streaming?
Yes — as of v1.6.1. Use `client.chatCompletionStream()` for native streaming or `stream: true` in the OpenAI-compatible client. Payment is handled automatically: the SDK signs USDC payment before streaming begins, and caches payment requirements per model so subsequent calls skip the 402 round-trip (~200ms faster).

### How much does it cost?
Pay only for what you use. Prices start at $0.0002 per request (GPT-5 Nano). There are no minimums, subscriptions, or monthly fees. $5 in USDC gets you thousands of requests.

### Does it support both Base and Solana?
Yes. Use `LLMClient` for Base (EVM) payments and `SolanaLLMClient` for Solana payments. Same API, different payment chain.

## License

MIT
