# Changelog

All notable changes to @blockrun/llm will be documented in this file.

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
