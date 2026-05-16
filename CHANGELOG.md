# Changelog

All notable changes to @blockrun/llm will be documented in this file.

## [2.2.0] - 2026-05-16

### Added

- **`VoiceClient` — AI-powered outbound phone calls via x402.** New module
  `src/voice.ts` wraps the backend's `POST /v1/voice/call` (paid, $0.54/call)
  and `GET /v1/voice/call/{callId}` (free polling). The AI agent dials a
  US/Canada E.164 number and conducts a real-time conversation following your
  `task` instructions; STT + LLM + TTS are handled upstream by Bland.ai. Full
  pass-through for `from`, `voice` (7 presets + custom Bland IDs),
  `max_duration` (1–30 min), `language`, `first_sentence`,
  `wait_for_greeting`, `interruption_threshold`, and `model` tier (`base` |
  `enhanced` | `turbo`). Status polling returns the full Bland call record
  (status, transcript, recording URL, ended_reason). Exported as `VoiceClient`
  from `@blockrun/llm` with public types `VoicePreset`, `CallModel`,
  `VoiceClientOptions`, `CallOptions`, `CallInitiatedResponse`,
  `CallStatusResponse`. See README "Voice Calls" section for usage.

## [2.1.1] - 2026-05-14

### Fixed

- **Export `VideoClient` from the package entry point.** The class was
  fully implemented in `src/video.ts` and documented in the README
  (`import { VideoClient } from '@blockrun/llm'`), but the export was
  missing from `src/index.ts`. Downstream consumers (Franklin,
  franklin-canvas) had to hand-roll their own x402 + polling loop
  against `/v1/videos/generations` even though a working client was
  already shipped — they just couldn't reach it. Restores the
  promised public surface; no source changes to `video.ts`.

### Changed

- **`RoutingProfile` removes `"free"` — breaking for TypeScript callers.**
  `@blockrun/clawrouter` 0.12.190 no longer accepts `"free"` as a
  routing profile in `route()`. The `"free"` literal is removed from the
  exported `RoutingProfile` union. TypeScript callers passing
  `routingProfile: 'free'` will get a compile error; JavaScript callers
  will fall through to auto-routing silently. Upgrade path: remove
  `routingProfile: 'free'` from your call sites (the gateway already
  routes to the most cost-effective model by default).

- **`RoutingDecision` adds `profile` and `agenticScore` fields.**
  Synced with `@blockrun/clawrouter` 0.12.190. `RoutingDecision.profile`
  now reflects the routing profile applied (`"eco" | "auto" | "premium" |
  "agentic"`). `RoutingDecision.agenticScore` surfaces the agentic
  routing score when the gateway activates agentic mode. Both fields are
  optional and absent when not applicable.

### Dependencies

- Bumped `@blockrun/clawrouter` `0.12.75` → `0.12.190`.
- Bumped `viem` `2.44.4` → `2.49.0`.

## 2.1.0

### Added

- **`ChatResponse.fallback` surfaces transparent gateway substitutions.**
  When the BlockRun gateway can't serve the requested model and routes
  to a free fallback, it sets `X-Fallback-Used`, `X-Fallback-Model`, and
  `X-Settlement-Skipped` on the HTTP response. The SDK now reads those
  headers and attaches a `fallback: { used: true, model, settlementSkipped }`
  field to the parsed `ChatResponse`. Without this, callers got a
  different model than they asked for with no signal — silent quality
  drop, and the on-chain balance didn't change even though the SDK's
  session counter incremented. Now:
  ```ts
  const r = await client.chatCompletion("openai/gpt-5.5", messages);
  if (r.fallback?.used) {
    console.warn(`got ${r.fallback.model} instead of gpt-5.5 (free)`);
  }
  ```
  Backwards-compatible: `fallback` is absent on normal responses.

## 2.0.0

### Breaking

- **Removed testnet support.** `testnetClient`, `LLMClient.isTestnet()`,
  and the `TESTNET_API_URL` constant are gone. Base Sepolia traffic
  has tailed off; the BlockRun gateway is mainnet-only. If you were
  using testnet, pin to `1.16.x` until you migrate.
- **`CostEntry` schema rewritten.** Old shape `{timestamp, model,
  inputTokens, outputTokens, costUsd}` → new shape `{ts, endpoint,
  cost_usd, model?, wallet?, network?, client_kind?}`. The new
  schema matches what Franklin's AgentClient already writes, so
  `cost_log.jsonl` is now a single unified stream. `getCostSummary()`
  tolerates the legacy `costUsd` field on older lines for one release.
- **Cost log path moved** from `~/.blockrun/data/costs.jsonl` to the
  canonical `~/.blockrun/cost_log.jsonl`. If you have analytics over
  the old path, point them at the new one.

### Fixed

- **`logCost()` is no longer dead code.** Every successful x402
  settlement on `LLMClient.chatCompletion`, `chatCompletionStream`,
  and the raw payment paths now writes a canonical cost_log entry.
  Previously the helper was defined but never invoked, so third-party
  SDK consumers had zero automatic cost visibility — only Franklin's
  Anthropic-compatible path was logging, via its own wrapper. After
  this release the SDK and Franklin share one ledger.

### Added

- **`getCostSummary()` now returns `byEndpoint`** alongside `byModel`,
  so you can see spend split across `/v1/chat/completions`,
  `/v1/images/generations`, `/v1/x/...`, etc.

## 1.16.0

Brings the TypeScript SDK in line with the Python SDK changes from
2026-05-09 (commits ee0d98e, 8bae0d0, 6f1370d, 3aacbc1).

### Added
- **`LLMClient.exa(path, body)` proxy method.** The four typed Exa wrappers
  (`exaSearch`, `exaFindSimilar`, `exaContents`, `exaAnswer`) were already on
  Base; the generic proxy now mirrors `SolanaLLMClient.exa()` so callers can
  reach Exa endpoints the typed wrappers don't surface. Base is the primary
  Exa path — the Solana gateway is awaiting `EXA_API_KEY` provisioning.
- **`fallbackModels` option on `chat()` / `chatCompletion()`.** When the
  primary model returns a transient error (timeouts, network failures,
  502/503/504/522/524), the SDK retries against the next model in the list
  before raising. 4xx and `PaymentError` propagate immediately. Each hop
  logs one stderr line.
- **`smartChat()` auto-populates the fallback chain.** `RoutingDecision`
  gains a `fallbacks?: string[]` field built from the chosen tier's fallback
  list (filtered to models the catalog can price). `smartChat` passes it
  through to `chat()` automatically — transient failures on the routed
  primary now fall over instead of bubbling up.
- **Synthesised per-token pricing for flat-billed models.** ZAI's GLM-5
  family now bills `pricing.flat` ($0.001/call) instead of per-token. The
  pricing map fed to ClawRouter previously resolved them to $0/$0, biasing
  routing decisions and inflating reported savings %. Flat models now get
  an equivalent per-token rate computed against an assumed ~1500-token
  call so router math reflects real cost.

### Changed
- **`listImageModels()` / `listAllModels()` use the unified `/v1/models`
  catalog.** The dedicated `/v1/images/models` endpoint was deprecated
  server-side; image rows now live alongside chat rows under the same
  endpoint, identified by `categories: ["image"]`. Both `LLMClient` and
  `ImageClient.listImageModels()` filter the unified catalog. `listAllModels`
  is now one fetch instead of two and tags rows by category. Existing
  callers see the same `ImageModel[]` / `(Model | ImageModel)[]` shapes.
- **README: Anthropic table now leads with `claude-opus-4.7`** ($5/$25 per
  1M, 1M context, agentic coding + adaptive thinking, 128K output);
  `claude-opus-4.6` marked hidden but still callable as in-family fallback.
  Free-model count corrected to 8 (6 visible + 2 hidden-callable). Exa
  documentation reworked to list Base (`LLMClient`) as the primary path.
  The contradictory "gpt-oss retired 2026-04-28" note replaced with a
  privacy advisory matching the re-enable on 2026-04-30.

### Removed
- **`black-forest/flux-1.1-pro` from public surface.** Backend dropped this
  model — README image-generation table no longer lists it and `image.ts`
  comment was trimmed. Existing callers who passed the ID directly will
  see a 404 from the gateway.

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
