# @blockrun/llm (TypeScript SDK)

TypeScript SDK for <!-- br:models.chatVisible -->82<!-- /br:models.chatVisible --> LLMs with streaming, smart routing, and pay-per-request billing.
Two authentication modes, one API surface:

- **Account API key** — `apiKey` / `BLOCKRUN_API_KEY` bills a BlockRun account at `https://api.blockrun.ai`. Register, mint keys and top up credits at https://user.blockrun.ai.
- **Wallet (x402)** — a wallet signature is the authentication; each request settles USDC on Base, Arc (`apiUrl: https://arc.blockrun.ai/api`, same `LLMClient` and key) or Solana. No account needed. The EVM domain signed follows the 402's `network` through `EVM_NETWORKS` in `src/x402.ts`; the 402's `extra` is never trusted for it.

## x402 `upto` (src/x402-upto.ts)

- `LLMClient` signs `upto` (Permit2, settled at the ACTUAL cost ≤ the signed ceiling) only when the 402 offers a usable upto option with `extra.facilitatorAddress` on the exact option's network, ONE batched RPC read (balance, allowance to Permit2, and USDC `nonces` when gas sponsoring is declared) succeeds, balance ≥ ceiling, and either allowance ≥ ceiling or the 402 declares `extensions.eip2612GasSponsoring`. Anything else, including any RPC/signing error, signs `exact` exactly as before. An `upto` payment rejected before any body (402, or a 4xx payment-verification body — `isPaymentRejection`) is re-sent exactly once as `exact` from the same 402 (`signAndSend`); if that is rejected too the ORIGINAL rejection surfaces. Rejection is remembered per wallet+network for the client's life (`uptoRejected`). 2xx is never retried (a `X-Free-Fallback: payment-failed` rescue is not retried but does disable upto). Never make a caller worse off than `exact`.
- Opt-out: `paymentScheme: "exact"` (also on `OpenAI`) or `BLOCKRUN_PAYMENT_SCHEME=exact`. Solana, Arc (no RPC in `evm-rpc.ts`) and the non-LLMClient clients always pay `exact`; `extractPaymentDetails` prefers the `exact` option so they are unaffected by an upto `accepts[1]`.
- The gas-sponsoring permit value MUST equal `permitted.amount` (the ceiling): the upto proxy's `_executePermit` reverts `Permit2612AmountMismatch` otherwise, and a MaxUint256 permit was rejected by CDP verify live on 2026-09-30 (`assertPermitMatchesPermitted`). So every gas-sponsored call needs its own permit, and `LLMClient.pendingPermits` (nonce guard, `PendingPermit`) makes calls pay `exact` while this client's last permit is unconsumed (on-chain USDC nonce <= its nonce) and before its deadline — a second permit at the same nonce reverted on mainnet the same day. One gas-sponsored upto in flight per wallet. Concurrency: `LLMClient.permitSlots` is reserved SYNCHRONOUSLY before the preflight's RPC await (three `Promise.all` calls all read nonce 6 and two reverted, 2026-09-30); a call without the slot passes `permitBlocked` and never signs a permit.
- Semantics are pinned to `@x402/evm` 2.28.0 by hardcoded vectors in `test/unit/x402-upto.test.ts`. The EIP-2612 domain is the SDK's own (`EVM_NETWORKS`), never the 402's `extra`.
- Spend: the upto amount is a CEILING. `bookPayment` books `PAYMENT-RESPONSE.amount` when present, else the ceiling with `cost_basis: "ceiling"` in cost_log and in `getSpending().uptoCeilingUsd`. Streams always book the ceiling (they settle after the last byte).

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
├── client.ts            # LLMClient (EVM: Base, Arc — the 402's network picks the chain)
├── solana-client.ts     # SolanaLLMClient
├── router-adapter.ts    # Bundled Router Core V3 adapter (smartChat / blockrun/* aliases)
├── api-key.ts           # Account API-key auth: resolveApiKeyAuth / ApiKeyAuth transport + poll
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
├── x402-upto.ts         # x402 `upto` (Permit2) signing + exact/upto selection policy
├── evm-rpc.ts           # Batched eth_call with failover (getBalance, upto preflight)
├── types.ts             # Type definitions
├── validation.ts        # Input validation
├── cache.ts             # Response caching
├── cost-log.ts          # Cost logging
├── setup.ts             # First-run setup (setupAgentClient / setupAgentWallet / setupAgentSolanaWallet)
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

## Account API keys (`src/api-key.ts`)

- Every client option bag extends `ApiKeyOptions`. `resolveApiKeyAuth()` runs first in each
  constructor: an explicit `apiKey` wins over the environment, an explicit `privateKey` forces
  wallet mode even when `BLOCKRUN_API_KEY` is set, and passing both explicitly throws. With
  neither explicit, `BLOCKRUN_API_KEY` beats the wallet env vars — a process holding both
  runs in account mode.
- `ApiKeyAuth` is the shared transport: it pins the credential to the configured origin
  (`resolveUrl` refuses cross-origin, credentialed, and off-port URLs, including poll URLs),
  sets `redirect: "error"`, strips caller `*payment*` / `x-api-key` headers, and redacts the
  key out of error bodies. Base URL defaults to `https://api.blockrun.ai`, overridable with
  `apiUrl` (`baseURL` on `OpenAI`) or `BLOCKRUN_API_BASE_URL`; a trailing `/v1` is trimmed.
- **An account error never falls back to a wallet.** `fetch()` raises on any non-2xx, so the
  x402 signing path is unreachable in account mode; `APIError` carries `statusCode`, the
  account `code`/`type`/`message`, and `retryAfter`.
- Async jobs (image / video / music / `BlockrunClient.poll`) follow `poll_url` from the first
  authenticated response via `ApiKeyAuth.poll()` — no 402 challenge, no second POST.
- **Transient retries are GET/HEAD-only.** 502/503/504/522/524 retry twice on idempotent
  requests; a POST is never replayed, because in account mode the first POST is the billed
  one (the wallet path can retry because its first POST is the unpaid 402 challenge).
  `poll()` rides out a transient error to the deadline instead of dropping a paid job.
- Wallet-only surfaces throw `requireWallet()` in account mode: `getWalletAddress()`,
  `getBalance()`, and `getSpending()` (account usage lives in the dashboard, not in-process).
- `setupAgentClient()` picks account mode when a key is configured, otherwise honours a saved
  `~/.blockrun/payment-chain` preference, keeps Base-only installs on Base, and defaults new
  wallets to Solana. `setupAgentWallet()` / `setupAgentSolanaWallet()` stay chain-specific.

## Supported chains

Only relevant in wallet mode; account API keys are chain-independent.

- Solana Mainnet — USDC SPL (recommended for new wallets)
- Base Mainnet — USDC
- Base Sepolia (testnet) — Testnet USDC

## Conventions

- TypeScript strict mode, ESM + CJS dual output
- Build with tsup
- Test with vitest
- Lint with eslint
- pnpm as package manager
- Node >= 20
- MIT license
- npm registry: `@blockrun/llm`
