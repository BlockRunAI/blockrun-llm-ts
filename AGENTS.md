# AGENTS.md

Guidance for AI coding agents working with the BlockRun TypeScript SDK.

## Project Overview

**@blockrun/llm** is a TypeScript SDK for pay-per-request access to AI models (GPT, Claude, Gemini, Grok) via x402 micropayments on Base and Solana.

**Package:** `@blockrun/llm` (npm)
**Node:** >=20
**Networks:** Base (EVM) and Solana
**Payment:** USDC via x402 v2

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
- Automatic x402 payment handling

## Key Files

| File | Purpose |
|------|---------|
| `client.ts` | Main `LLMClient` with `chat()`, `chatCompletion()`, `listModels()` |
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
