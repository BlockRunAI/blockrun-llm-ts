# @blockrun/llm (TypeScript SDK)

TypeScript SDK for <!-- br:models.chatVisible -->74<!-- /br:models.chatVisible --> LLMs with streaming, smart routing, and automatic USDC micropayments via x402. No API keys — wallet signature is authentication.

## Commands

```bash
npm install              # install dependencies
npm run build            # compile with tsup (CJS + ESM + DTS)
npm run dev              # watch mode
npm test                 # run vitest
npm run typecheck        # type checking
npm run lint             # eslint
```

## Project structure

```
src/
├── index.ts             # Package exports
├── client.ts            # LLMClient (Base chain)
├── solana-client.ts     # SolanaLLMClient
├── router-adapter.ts    # Bundled Router Core V3 adapter (smartChat / blockrun/* aliases)
├── blockrun.ts          # BlockrunClient — universal x402 primitive (get/post/poll/stream)
├── image.ts             # ImageClient — image generation + editing (multi-image fusion)
├── video.ts             # VideoClient — video generation (incl. realFaceAssetId)
├── portrait.ts          # PortraitClient — Virtual Portrait enrollment (ta_xxxxxx)
├── music.ts             # MusicClient — music/audio generation
├── speech.ts            # SpeechClient — TTS + sound effects (BlockRun Voice / ElevenLabs)
├── voice.ts             # VoiceClient — AI outbound phone calls
├── phone.ts             # PhoneClient — phone lookup + number provisioning
├── search.ts            # SearchClient — Grok Live Search
├── price.ts             # PriceClient — Pyth market data
├── surf.ts              # SurfClient — /v1/surf/* crypto data catalog
├── rpc.ts               # RpcClient — multi-chain JSON-RPC (Tatum, 40+ chains)
├── solana-deps.ts       # Lazy loader for the optional Solana peer deps
├── version.ts           # Single source of SDK_VERSION / USER_AGENT
├── wallet.ts            # EVM wallet management
├── solana-wallet.ts     # Solana wallet management
├── x402.ts              # x402 payment protocol
├── types.ts             # Type definitions
├── validation.ts        # Input validation
├── cache.ts             # Response caching
├── cost-log.ts          # Cost logging
├── setup.ts             # First-run setup
├── anthropic-compat.ts  # Anthropic SDK compatibility layer
└── openai-compat.ts     # OpenAI SDK compatibility layer
```

## Key dependencies

- `@blockrun/router-core` — bundled, product-neutral smart model routing
- `@blockrun/core` — Shared kernel; owns Base wallet resolution, discovery, and adoption
  so this SDK, the `blockrun` CLI, and clawrouter-codex read the same wallet
- `viem` — Ethereum interaction
- `bs58` — Base58 encoding (Solana)
- Optional: `@anthropic-ai/sdk`, `@solana/web3.js`, `@solana/spl-token`

## Smart routing (smartChat / router-core)

- `smartChat()`, `smartChatCompletion()`, `route()`, and the `blockrun/auto|eco|premium` model aliases call the bundled Router Core V3 adapter (`src/router-adapter.ts`) on both chain clients. The aliases are NOT resolved by the Anthropic-compat layer (it proxies straight to `/v1/messages`).
- **Candidate policy (do not re-break — v3.11.0's 291668d and PR #25's review both litigated this):** the router's ranking is trusted as-is, including ids withheld from `/v1/models` (e.g. `moonshot/kimi-k2.7` — gateway serves them by direct id). The one exception is the `free/<model>` proxy namespace: map to the catalog-listed `nvidia/<model>` id, drop when there is no mapping. Strict `modelPricing.has()` filtering silently converts eco from $0 to paid and swaps premium's picks.
- Transient fallback (shared `isTransientError` in router-adapter.ts): timeout / network / 429 / 502 / 503 / 504 / 522 / 524. Both clients walk the chain and log each hop to stderr. Caller-supplied `fallbackModels` beats the routed chain.
- The routing runtime and types are **derived directly from `@blockrun/router-core`**, pinned to an immutable GitHub commit. Do not hand-edit the upstream shapes; re-pin the reviewed router-core commit and rerun golden tests.
- `tsup.config.ts` holds the build config; its `dts.resolve` inlines the router-core declarations into the shipped `.d.ts`. After any routing-dependency bump, verify `grep -c router-core dist/index.d.ts` prints `0` — a leaked `import from '@blockrun/router-core'` is unresolvable in consumer trees. The full procedure is in CONTRIBUTING.md.

## Supported chains

- Base Mainnet (primary) — USDC
- Base Sepolia (testnet) — Testnet USDC
- Solana Mainnet — USDC SPL

## Conventions

- TypeScript strict mode, ESM + CJS dual output
- Build with tsup
- Test with vitest
- Lint with eslint
- pnpm as package manager
- Node >= 20
- MIT license
- npm registry: `@blockrun/llm`
