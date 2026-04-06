# @blockrun/llm (TypeScript SDK)

TypeScript SDK for 41+ LLMs with streaming, smart routing, and automatic USDC micropayments via x402. No API keys — wallet signature is authentication.

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
├── wallet.ts            # EVM wallet management
├── solana-wallet.ts     # Solana wallet management
├── x402.ts              # x402 payment protocol
├── types.ts             # Type definitions
├── validation.ts        # Input validation
├── cache.ts             # Response caching
├── cost-log.ts          # Cost logging
├── image.ts             # Image generation
├── setup.ts             # First-run setup
├── anthropic-compat.ts  # Anthropic SDK compatibility layer
└── openai-compat.ts     # OpenAI SDK compatibility layer
```

## Key dependencies

- `@blockrun/clawrouter` — Smart model routing
- `viem` — Ethereum interaction
- `bs58` — Base58 encoding (Solana)
- Optional: `@anthropic-ai/sdk`, `@solana/web3.js`, `@solana/spl-token`

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
