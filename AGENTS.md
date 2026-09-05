# AGENTS.md

Guidance for AI coding agents working with the BlockRun TypeScript SDK.

## Project Overview

**@blockrun/llm** is a TypeScript SDK that **cuts LLM costs by up to <!-- br:savings.autoVsBaselinePct -->84<!-- /br:savings.autoVsBaselinePct -->%**: its bundled smart router (Router Core V3) picks the cheapest capable model for every request — locally, in <1ms — and pays per-request in USDC via x402 on Base or Solana. API key account billing or x402 wallet payments. Use `smartChat()` for routed (cheapest) calls; `chat()` to pin a model. **Includes <!-- br:models.free -->7<!-- /br:models.free --> fully-free models** — Nemotron 3.5 Lightning and Nemotron 3 Ultra 550B (1M ctx), Nemotron 3 Nano Omni (multimodal, 256K), Nemotron 3 Nano 30B, Llama 3.2 11B Vision, Cohere North Mini Code (256K coding) and Poolside Laguna XS 2.1. The free tier is no longer NVIDIA-only, so pin them by full model id rather than by an `nvidia/*` prefix, or use `routingProfile: 'eco'`, which ranks the free tier first. (There is no `'free'` routing profile — `routingProfile` accepts `'eco' | 'auto' | 'premium'`.)

**Package:** `@blockrun/llm` (npm)
**Node:** >=20
**Networks:** Solana (recommended) and Base (EVM)
**Payment:** USDC via x402 v2 (or $0 on the free tier)

## Repository Structure

```
blockrun-llm-ts/
├── src/
│   ├── index.ts         # Package exports
│   ├── client.ts        # LLMClient class
│   ├── image.ts         # Image generation
│   ├── openai-compat.ts # OpenAI-compatible client wrapper
│   ├── types.ts         # TypeScript interfaces
│   ├── validation.ts    # Input validation
│   ├── wallet.ts        # Wallet operations (Base + Solana)
│   └── x402.ts          # x402 payment protocol
├── test/                # Vitest tests
├── dist/                # Build output (generated)
├── package.json
├── tsconfig.json
└── README.md
```

## Development Commands

```bash
# Install
pnpm install

# Build
pnpm build              # Build with tsup (CJS + ESM + types)
pnpm dev                # Build in watch mode

# Testing
pnpm test               # Run tests in watch mode
pnpm test run           # Run tests once
pnpm test -- --coverage # With coverage

# Code Quality
pnpm lint               # ESLint
pnpm typecheck          # TypeScript check
```

## Code Conventions

### TypeScript
- Strict mode enabled
- Export types explicitly from `index.ts`
- Use `interface` for objects, `type` for unions
- Full JSDoc comments for public APIs

### Build
- tsup bundler (CJS, ESM, and .d.ts output)
- Tree-shakeable exports
- Solana dependencies are optional

### Architecture
- `LLMClient` - Main client class
- `chat()` - Simple chat method
- `chatCompletion()` - Full OpenAI-compatible response
- `smartChat()` / `smartChatCompletion()` - bundled Router Core V3 (see below)
- Automatic x402 payment handling

## Smart Routing (smartChat)

- `client.smartChat(prompt, { routingProfile? })` picks the cheapest capable
  model per request. Profiles: `'eco' | 'auto' | 'premium'` (default `auto`).
  `smartChatCompletion(messages, options)` routes full agent/tool turns;
  `route(prompt)` inspects a decision without paying. The
  `blockrun/auto|eco|premium` aliases work in `chat()`, `chatCompletion()`,
  and `chatCompletionStream()` on both chain clients and the OpenAI-compat
  layer — NOT in the Anthropic-compat layer (it proxies `/v1/messages` raw).
- Router Core is bundled; consumers install no separate router package.
- The default strategy is the deterministic portfolio router
  (`routing.method: 'portfolio'`): local classification, hard capability
  filters, ranked `routing.candidates`. Candidate policy: the ranking is
  trusted as-is (including ids withheld from `/v1/models`); the `free/*`
  proxy namespace is mapped to catalog-listed `nvidia/*` ids (dropped when
  proxy-only). The SDK builds `routing.fallbacks` from that ranking and
  `chat()` walks it automatically on transient errors (timeout / network /
  429 / 5xx). Caller-supplied `fallbackModels` wins over the routed chain.
- Routing types (`RoutingDecision`, `RoutingTier`, `RoutingTaskType`,
  `RoutingTierConfig`) are derived from `@blockrun/router-core` — a
  devDependency pinned to the reviewed Router Core commit —
  and ship inlined in the SDK's `.d.ts`, so consumers typecheck without
  installing another package. Do not hand-edit these shapes; re-pin the
  router-core commit when upgrading the engine (procedure in CONTRIBUTING.md).

## Key Files

| File | Purpose |
|------|---------|
| `client.ts` | Main `LLMClient` with `chat()`, `chatCompletion()`, `smartChat()`, `smartChatCompletion()`, `route()`, `listModels()` |
| `router-adapter.ts` | Bundled Router Core V3 adapter — candidate mapping (`free/*`→`nvidia/*`), capacity filter, shared transient-error logic |
| `solana-client.ts` | `SolanaLLMClient` with the same routing/fallback surface, paid on Solana |
| `tsup.config.ts` | Build config; `dts.resolve` inlines `@blockrun/router-core` types into the shipped `.d.ts` |
| `x402.ts` | x402 payment protocol implementation |
| `wallet.ts` | Base wallet: resolution/discovery/adoption delegated to `@blockrun/core` (bundled into dist); funding/messaging surface SDK-local |
| `solana-wallet.ts` | Solana wallet — deliberately SDK-local (core has no Solana key store yet); does not honor `BLOCKRUN_HOME` |
| `validation.ts` | Input validation for keys, URLs, parameters |
| `types.ts` | TypeScript interfaces for API |
| `openai-compat.ts` | OpenAI SDK compatible wrapper |

## Network Support

### Base (explicit wallet client)
- Uses `viem` for signing
- Environment: `BASE_CHAIN_WALLET_KEY`

### Solana
- Uses `@solana/web3.js` (optional dependency)
- Environment: `SOLANA_WALLET_KEY` (base58-encoded secret key)
- Gasless transactions (facilitator pays fees)

## Testing

### Unit Tests
```bash
pnpm test run
```

### Integration Tests
Requires funded wallet:
```bash
export BASE_CHAIN_WALLET_KEY=0x...
pnpm test -- test/integration
```

## Publishing

```bash
pnpm build
npm publish --access public
```

## Security Notes

- Private keys never leave the machine
- HTTPS required for production
- Solana keys are base58 encoded
- Error messages are sanitized

## Account API authentication

All service clients accept `apiKey` / `BLOCKRUN_API_KEY`. Shared transport in
`src/api-key.ts` authenticates against `https://api.blockrun.ai`, prevents x402
replay on account errors, and scopes credentials to the configured origin.
`setupAgentClient()` chooses account mode first, then preserves existing chain
preferences/Base-only wallets, otherwise initializes Solana. The named wallet
setup functions remain chain-specific. Register at https://user.blockrun.ai.
