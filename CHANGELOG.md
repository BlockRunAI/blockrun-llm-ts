# Changelog

All notable changes to @blockrun/llm will be documented in this file.

## 1.15.0

- **Predexon v2 endpoints exposed via typed helpers.** All v2 endpoints went live in production on 2026-05-07 (`blockrun-web-00451-cnw`). The generic `pm()` / `pmQuery()` passthrough already routed them, but agents can now discover the new shape from method names + JSDoc. Ten new convenience methods on `LLMClient` — each is a thin wrapper, no breaking changes:
  - **Canonical cross-venue (Tier 1):** `pmMarkets(params?)`, `pmListings(params?)`, `pmOutcome(predexonId)`. Predexon's unified data layer with cross-venue IDs across Polymarket, Kalshi, Limitless, Opinion, Predict.Fun.
  - **Polymarket keyset pagination (Tier 1):** `pmPolymarketMarketsKeyset(params?)`, `pmPolymarketEventsKeyset(params?)` — cursor-based for stable traversal of large result sets.
  - **Sports markets (Tier 1):** `pmSportsCategories()`, `pmSportsMarkets(params?)`.
  - **Wallet identity & clustering (Tier 2):** `pmWalletIdentity(wallet)` (GET), `pmWalletIdentities(addresses)` (POST, up to 200), `pmWalletCluster(address)` (GET on-chain relationship graph).
- `pm()` / `pmQuery()` JSDoc updated to advertise v2 examples and surface the Tier 1 / Tier 2 split inline.

## 1.14.0

- **DeepSeek V4 family in paid catalog.** Backend added `deepseek/deepseek-v4-pro` (1.6T MoE / 49B active, 1M context — strongest open-weight reasoner; MMLU-Pro 87.5, GPQA 90.1, SWE-bench 80.6, LiveCodeBench 93.5; **$0.50 in / $1.00 out per 1M under the 75% promo through 2026-05-31**, list $2.00/$4.00). The legacy `deepseek/deepseek-chat` and `deepseek/deepseek-reasoner` IDs are now V4 Flash non-thinking / thinking modes — repriced to **$0.20 in / $0.40 out per 1M, 1M context** (was $0.28/$0.42, 128K). Same upstream as `nvidia/deepseek-v4-flash` but on the paid endpoint with higher reliability and 5MB request bodies. No SDK source changes — `chat()` / `chatCompletion()` / smart routing pick up the new pricing automatically.
- README refresh: DeepSeek pricing table now shows V4 Pro / V4 Flash chat / V4 Flash reasoner with correct prices and 1M context. NVIDIA free table notes that `gpt-oss-120b/20b` are hidden from `/v1/models` but still callable by direct ID (re-enabled 2026-04-30 after a brief privacy delisting); `V4 Pro` / `V3.2` / `glm-4.7` listed as hidden + redirect targets.
- **`XClient` deprecated.** BlockRun's `/v1/x/*` (AttentionVC-partnered) integration was removed from the backend on 2026-04-30 (commit 80dcf52). The class is kept so existing imports do not break, but `new XClient()` now logs a one-time `console.warn` — all calls return HTTP 404 until a replacement upstream is wired up. JSDoc `@deprecated` tag added so editors flag use sites.
- **DeepSeek V4 thinking + tool-call multi-turn now works.** Backend commit `f8a2d44` (2026-05-03) preserves `reasoning_content` on assistant messages with `tool_calls` for DeepSeek V4 thinking-mode (`deepseek-reasoner` / `deepseek-v4-pro`). The SDK `ChatMessage` interface already carried `reasoning_content?` and `thinking?` fields, so the fix is purely server-side; this entry exists so users seeing past 5xx-retry-loop failures know they're resolved.

## 1.13.0

- **fix(solana): `createSolanaWallet` now uses `await import()` instead of `require()` for `@solana/web3.js` and `bs58`.** The previous CJS-style lazy require was wrapped by esbuild's `__require` shim during the ESM build, which threw `Dynamic require of "@solana/web3.js" is not supported` whenever an ESM consumer (e.g. Franklin under Node ≥ 20) called `franklin setup solana`. Switching to `await import()` matches the pattern already used by `solanaPublicKey` and `solanaKeyToBytes` in the same file. The optional-dep posture is preserved — `@solana/web3.js` and `bs58` are still loaded lazily.
- **Breaking-ish:** `createSolanaWallet` is now `async` (returns `Promise<{ address, privateKey }>`). The only internal caller (`getOrCreateSolanaWallet`, already async) was updated. External callers using `createSolanaWallet` directly must add `await`. Bumped as a minor since `getOrCreateSolanaWallet` — the recommended API — is unchanged.

## 1.12.1

- **Moonshot flagship: `moonshot/kimi-k2.6`** — 256K context, vision + text, returns `reasoning_content`. Pricing $0.95 in / $4.00 out per 1M tokens. Available in the catalog (FEATURED on the homepage); `kimi-k2.5` is now hidden as superseded but remains routable for clients pinned to its pricing. Pass the model ID like any other to `chat.completions`. No SDK source changes — smart routing lives in `@blockrun/clawrouter` and will pick up the new catalog flagship on its next release.
- README Moonshot section already lists `moonshot/kimi-k2.6` and `moonshot/kimi-k2.5` side-by-side.

## 1.11.0

- **New flagship model: `openai/gpt-5.5`** (released 2026-04-23, first fully retrained base since GPT-4.5). 1M context, 128K output, native agent + computer use. Pricing $5.00 / $30.00 per 1M tokens. Catalog-only entry in the README; chat/completions surface unchanged — pass the model ID like any other.
- Reconciles `VERSION` (was 1.9.0) with `package.json` (was 1.10.1); both now 1.11.0.

## 1.10.1

- **`ImageClient` default timeout 120s → 200s.** The gateway's per-call OpenAI
  timeout for `gpt-image-2` was bumped to 180s server-side (it routinely takes
  ~120-180s at 1536x1024 and larger), so the SDK's old 120s default was cutting
  the request before the server had a chance to return. New default leaves
  ~20s of buffer above the server cap. Existing users passing an explicit
  `timeout` option are unaffected.

## 1.10.0

- **VideoClient switches to async submit+poll**. Upstream `/v1/videos/generations`
  moved from sync to async on 2026-04-23 (submit returns a job id; client polls
  until completion). Public signature of `VideoClient.generate(...)` is unchanged
  — still blocks until the video is ready and returns `VideoResponse` with the
  MP4 URL and tx hash. Internally the client now signs once, submits, and
  replays the same signature on GET polls every 5s until upstream completes.
  Settlement only fires on the first completed poll, so upstream failure or
  budget exhaustion = zero charge.
- Added `budgetMs` option to `generate()` (default 300000) to cap the polling
  window.
- Bumped advertised `maxTimeoutSeconds` on video requests from 300s to 600s so
  the signed auth stays valid across the full polling window.

## 1.9.0

- **New image model: `openai/gpt-image-2`** (ChatGPT Images 2.0 — reasoning-driven, multilingual text rendering, character consistency, high-fidelity edits). Pricing $0.06 for 1024² / $0.12 for 1536×1024 or 1024×1536. Supports both `/v1/images/generations` and `/v1/images/image2image` edit endpoint. `gpt-image-1` remains available for legacy callers.
- **New video models: 3 ByteDance Seedance variants** on `VideoClient` via `/v1/videos/generations` (routed through the token360 provider backend-side):
  - `bytedance/seedance-1.5-pro` — $0.03/sec, 720p, 5s default (up to 10s), cheapest AI video on the gateway.
  - `bytedance/seedance-2.0-fast` — $0.15/sec, ~60-80s gen time, sweet-spot price/quality.
  - `bytedance/seedance-2.0` — $0.30/sec, 720p Pro quality.
  All three support text-to-video and image-to-video, with server-side 85s hard cap on the polling loop. No SDK surface change — pass the new model ID to `VideoClient.generate()`.
- `client.edit()` type narrowing widened to accept `"openai/gpt-image-1" | "openai/gpt-image-2"` per backend `EDIT_SUPPORTED_MODELS`.
- README: new rows in Image/Video model tables, plus note on which edit models are supported.

## 1.8.1

- **NVIDIA free-tier refresh (backend 2026-04-21).** README NVIDIA section now lists the 8 visible survivors + the two new models (`nvidia/qwen3-next-80b-a3b-thinking`, `nvidia/mistral-small-4-119b`), and points at `moonshot/kimi-k2.5` as the canonical replacement for the retired paid `nvidia/kimi-k2.5`. No SDK source changes — smart routing lives in `@blockrun/clawrouter` and will pick up the new catalogue on its next release.
- Smart Routing example in the README renamed `nvidia/kimi-k2.5` → `moonshot/kimi-k2.5` in the sample output.

## 1.8.0

- **New `SearchClient`** — wraps `POST /v1/search` (standalone Grok Live Search). $0.025 per source + margin, 1–50 sources per call.
- **New `XClient`** — 13 methods mapping the `/v1/x/*` endpoints (user lookup/info/followers/following/verified-followers/tweets/mentions, tweet lookup/replies/thread, search, trending, articles/rising). Fills the gap where `X*` response types were exported but had no caller.
- **New `PriceClient`** — Pyth-backed market data with `.price()`, `.history()`, `.listSymbols()`. Crypto, FX and commodity are fully free (price + history + list); stocks across 12 markets (us/hk/jp/kr/gb/de/fr/nl/ie/lu/cn/ca) and the `usstock` legacy alias charge for price + history, list stays free. The client handles both paths transparently; pass `requireWallet: false` for free-only usage.
- New types: `PriceCategory`, `StockMarket`, `BarResolution`, `MarketSession`, `PricePoint`, `PriceBar`, `PriceHistoryResponse`, `SymbolListResponse`, `PriceOptions`, `HistoryOptions`, `ListOptions`, plus `SearchClientOptions`, `XClientOptions`, `PriceClientOptions`.
- `ChatMessage` gains optional `reasoning_content` and `thinking` fields for reasoning-capable upstreams (DeepSeek Reasoner, Grok 4 / 4.20 reasoning).
- `ChatUsage` gains optional `cache_read_input_tokens` / `cache_creation_input_tokens` for Anthropic prompt-caching telemetry.
- `Model` gains optional `billingMode` (`paid`/`flat`/`free`), `flatPrice`, `hidden` so `/v1/models` metadata can round-trip.
- `VERSION` synced to match `package.json`.

## 1.7.0

- **New `VideoClient`** — generate AI videos via `xai/grok-imagine-video` ($0.05/sec, 8s default).
- `VideoResponse`, `VideoClip`, `VideoModel`, `VideoClientOptions`, `VideoGenerateOptions` exported.
- Text-to-video and image-to-video supported; client blocks until polling completes (~30-120s).
- `ImageData` gains optional `source_url` and `backed_up` fields for gateway-mirrored assets.
- Grok Imagine image models (`xai/grok-imagine-image`, `-pro`) routable via `ImageClient`.
- Grok 4.20 chat models (`xai/grok-4.20-reasoning`, `-non-reasoning`, `-multi-agent`) routable via the chat API.

## 1.6.1

- 41+ models with streaming support
- Base and Solana chain payments
- x402 v2 protocol (CDP Facilitator)
- Smart routing via @blockrun/clawrouter
- Anthropic SDK compatibility layer
- OpenAI SDK compatibility layer
- Image generation support
- Response caching and cost logging
