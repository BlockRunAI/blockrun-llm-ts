# AGENTS.md

Guidance for AI coding agents working with the BlockRun TypeScript SDK.

## Project Overview

**@blockrun/llm** is a TypeScript SDK that **cuts LLM costs by up to 88%**: its built-in smart router (ClawRouter) picks the cheapest capable model for every request — locally, in <1ms — and pays per-request in USDC via x402 on Base or Solana. No API keys, no subscriptions. Use `smartChat()` for routed (cheapest) calls; `chat()` to pin a model. **Includes 6 fully-free NVIDIA-hosted models** — DeepSeek V4 Flash (1M ctx), Nemotron Nano Omni (multimodal), Mistral Nemotron, Step 3.7 Flash, and the Nemotron Nano pair — plus the hidden gpt-oss pair, directly callable. Access them by calling any `nvidia/*` model id directly, or via `routingProfile: 'eco'`, which ranks the free tier first. (There is no `'free'` routing profile — `routingProfile` accepts `'eco' | 'auto' | 'premium'`.)

**Package:** `@blockrun/llm` (npm)
**Node:** >=20
**Networks:** Base (EVM) and Solana
**Payment:** USDC via x402 v2 (or $0 for `nvidia/*` free tier)

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
- `smartChat()` - Automatic model routing via ClawRouter (see below)
- Automatic x402 payment handling

## Smart Routing (smartChat)

- `client.smartChat(prompt, { routingProfile? })` picks the cheapest capable
  model per request. Profiles: `'eco' | 'auto' | 'premium'` (default `auto`).
- Requires the **optional peer** `@blockrun/clawrouter` (`npm install
  @blockrun/clawrouter`). It is lazy-loaded inside `smartChat()` only — every
  other API works without it, and a missing router throws an actionable error
  instead of breaking the import.
- The default strategy is ClawRouter's deterministic portfolio router
  (`routing.method: 'portfolio'`): local classification, hard capability
  filters, ranked `routing.candidates`. The SDK builds `routing.fallbacks`
  from that ranking (primary excluded, unpriced models filtered) and `chat()`
  walks it automatically on transient errors (timeout / network / 5xx).
- Routing types (`RoutingDecision`, `RoutingTier`, `RoutingTaskType`,
  `RoutingTierConfig`) are derived from `@blockrun/router-core` — a
  devDependency pinned to the commit ClawRouter's published build inlines —
  and ship inlined in the SDK's `.d.ts`, so consumers typecheck without
  installing either package. Do not hand-edit these shapes; re-pin the
  router-core commit whenever `@blockrun/clawrouter` is bumped (procedure in
  CONTRIBUTING.md).

## Key Files

| File | Purpose |
|------|---------|
| `client.ts` | Main `LLMClient` with `chat()`, `chatCompletion()`, `smartChat()`, `listModels()` |
| `tsup.config.ts` | Build config; `dts.resolve` inlines `@blockrun/router-core` types into the shipped `.d.ts` |
| `x402.ts` | x402 payment protocol implementation |
| `wallet.ts` | Multi-network wallet support (Base via viem, Solana via @solana/web3.js) |
| `validation.ts` | Input validation for keys, URLs, parameters |
| `types.ts` | TypeScript interfaces for API |
| `openai-compat.ts` | OpenAI SDK compatible wrapper |

## Network Support

### Base (Default)
- Uses `viem` for signing
- Environment: `BASE_CHAIN_WALLET_KEY`

### Solana
- Uses `@solana/web3.js` (optional dependency)
- Environment: `BLOCKRUN_SOLANA_KEY` (base58)
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
