# @blockrun/llm (TypeScript SDK)

TypeScript SDK for <!-- br:models.chatVisible -->71<!-- /br:models.chatVisible --> LLMs with streaming, smart routing, and automatic USDC micropayments via x402. No API keys — wallet signature is authentication.

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

- `@blockrun/clawrouter` — Smart model routing (optional peer; only `smartChat()` needs it)
- `viem` — Ethereum interaction
- `bs58` — Base58 encoding (Solana)
- Optional: `@anthropic-ai/sdk`, `@solana/web3.js`, `@solana/spl-token`

## Smart routing (smartChat / ClawRouter / router-core)

- `smartChat()` lazy-loads `@blockrun/clawrouter` (optional peer) inside the method, so a missing or broken router can never break importing the SDK. Since ClawRouter v0.12.242 the default decision is the deterministic **portfolio** strategy: `routing.method: "portfolio"`, with an ordered `routing.candidates` list that the SDK turns into the transient-error fallback chain (primary excluded, unpriced models filtered). Rules-mode decisions fall back to `getFallbackChain()` over the tier configs. Behavior is pinned by `test/unit/smart-chat-fallbacks.test.ts`.
- The routing types in `src/types.ts` are **derived from `@blockrun/router-core`**, a devDependency installed from a GitHub tarball (router-core is not on npm) pinned to the exact commit ClawRouter's published build inlines. Do not hand-edit these shapes — and when bumping `@blockrun/clawrouter`, re-pin the router-core URL to the commit in the new ClawRouter's `package.json` `devDependencies`. They move together.
- `tsup.config.ts` holds the build config (moved from CLI flags); its `dts.resolve` inlines the router-core declarations into the shipped `.d.ts`. After any routing-dependency bump, verify `grep -c router-core dist/index.d.ts` prints `0` — a leaked `import from '@blockrun/router-core'` is unresolvable in consumer trees and reproduces the declaration gap ClawRouter's own `.d.ts` has. The full procedure is in CONTRIBUTING.md.

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
