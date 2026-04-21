# Changelog

All notable changes to @blockrun/llm will be documented in this file.

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
