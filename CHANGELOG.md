# Changelog

All notable changes to @blockrun/llm will be documented in this file.

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
