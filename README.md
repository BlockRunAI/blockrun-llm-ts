# @blockrun/llm

Pay-per-request access to GPT-4o, Claude 4, Gemini 2.5, and more via x402 micropayments on Base and Solana.

**Networks:**
- **Base Mainnet:** Chain ID 8453 - Production with real USDC
- **Base Sepolia (Testnet):** Chain ID 84532 - Developer testing with testnet USDC
- **Solana Mainnet** - Production with real USDC

**Payment:** USDC
**Protocol:** x402 v2 (CDP Facilitator)

## Installation

```bash
# Base and Solana support (optional Solana deps auto-installed)
npm install @blockrun/llm
# or
pnpm add @blockrun/llm
# or
yarn add @blockrun/llm
```

## Quick Start (Base - Default)

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();  // Uses BASE_CHAIN_WALLET_KEY (never sent to server)
const response = await client.chat('openai/gpt-4o', 'Hello!');
```

That's it. The SDK handles x402 payment automatically.

## Quick Start (Solana)

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient({ network: 'solana' });  // Uses BLOCKRUN_SOLANA_KEY
const response = await client.chat('openai/gpt-4o', 'Hello!');
```

For Solana, set `BLOCKRUN_SOLANA_KEY` environment variable with your base58-encoded Solana secret key.

## How It Works

1. You send a request to BlockRun's API
2. The API returns a 402 Payment Required with the price
3. The SDK automatically signs a USDC payment on Base
4. The request is retried with the payment proof
5. You receive the AI response

**Your private key never leaves your machine** - it's only used for local signing.

## Available Models

### OpenAI GPT-5 Family
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `openai/gpt-5.2` | $1.75/M | $14.00/M |
| `openai/gpt-5` | $1.25/M | $10.00/M |
| `openai/gpt-5-mini` | $0.25/M | $2.00/M |
| `openai/gpt-5-nano` | $0.05/M | $0.40/M |
| `openai/gpt-5.2-pro` | $21.00/M | $168.00/M |

### OpenAI GPT-4 Family
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `openai/gpt-4.1` | $2.00/M | $8.00/M |
| `openai/gpt-4.1-mini` | $0.40/M | $1.60/M |
| `openai/gpt-4.1-nano` | $0.10/M | $0.40/M |
| `openai/gpt-4o` | $2.50/M | $10.00/M |
| `openai/gpt-4o-mini` | $0.15/M | $0.60/M |

### OpenAI O-Series (Reasoning)
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `openai/o1` | $15.00/M | $60.00/M |
| `openai/o1-mini` | $1.10/M | $4.40/M |
| `openai/o3` | $2.00/M | $8.00/M |
| `openai/o3-mini` | $1.10/M | $4.40/M |
| `openai/o4-mini` | $1.10/M | $4.40/M |

### Anthropic Claude
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `anthropic/claude-opus-4.5` | $5.00/M | $25.00/M |
| `anthropic/claude-opus-4` | $15.00/M | $75.00/M |
| `anthropic/claude-sonnet-4` | $3.00/M | $15.00/M |
| `anthropic/claude-haiku-4.5` | $1.00/M | $5.00/M |

### Google Gemini
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `google/gemini-3-pro-preview` | $2.00/M | $12.00/M |
| `google/gemini-2.5-pro` | $1.25/M | $10.00/M |
| `google/gemini-2.5-flash` | $0.15/M | $0.60/M |

### DeepSeek
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `deepseek/deepseek-chat` | $0.28/M | $0.42/M |
| `deepseek/deepseek-reasoner` | $0.28/M | $0.42/M |

### xAI Grok
| Model | Input Price | Output Price | Context | Notes |
|-------|-------------|--------------|---------|-------|
| `xai/grok-3` | $3.00/M | $15.00/M | 131K | Flagship |
| `xai/grok-3-fast` | $5.00/M | $25.00/M | 131K | Tool calling optimized |
| `xai/grok-3-mini` | $0.30/M | $0.50/M | 131K | Fast & affordable |
| `xai/grok-4-1-fast-reasoning` | $0.20/M | $0.50/M | **2M** | Latest, chain-of-thought |
| `xai/grok-4-1-fast-non-reasoning` | $0.20/M | $0.50/M | **2M** | Latest, direct response |
| `xai/grok-4-fast-reasoning` | $0.20/M | $0.50/M | **2M** | Step-by-step reasoning |
| `xai/grok-4-fast-non-reasoning` | $0.20/M | $0.50/M | **2M** | Quick responses |
| `xai/grok-code-fast-1` | $0.20/M | $1.50/M | 256K | Code generation |
| `xai/grok-4-0709` | $0.20/M | $1.50/M | 256K | Premium quality |
| `xai/grok-2-vision` | $2.00/M | $10.00/M | 32K | Vision capabilities |

### Moonshot Kimi
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `moonshot/kimi-k2.5` | $0.55/M | $2.50/M |

### NVIDIA (Free & Hosted)
| Model | Input Price | Output Price | Notes |
|-------|-------------|--------------|-------|
| `nvidia/gpt-oss-120b` | **FREE** | **FREE** | OpenAI open-weight 120B (Apache 2.0) |
| `nvidia/kimi-k2.5` | $0.55/M | $2.50/M | Moonshot 1T MoE with vision |

### E2E Verified Models

All models below have been tested end-to-end via the TypeScript SDK (Feb 2026):

| Provider | Model | Status |
|----------|-------|--------|
| OpenAI | `openai/gpt-4o-mini` | Passed |
| Anthropic | `anthropic/claude-sonnet-4` | Passed |
| Google | `google/gemini-2.5-flash` | Passed |
| DeepSeek | `deepseek/deepseek-chat` | Passed |
| xAI | `xai/grok-3-fast` | Passed |
| Moonshot | `moonshot/kimi-k2.5` | Passed |

### Image Generation
| Model | Price |
|-------|-------|
| `openai/dall-e-3` | $0.04-0.08/image |
| `openai/gpt-image-1` | $0.02-0.04/image |
| `google/nano-banana` | $0.05/image |
| `google/nano-banana-pro` | $0.10-0.15/image |
| `black-forest/flux-1.1-pro` | $0.04/image |

### Testnet Models (Base Sepolia)
| Model | Price |
|-------|-------|
| `openai/gpt-oss-20b` | $0.001/request |
| `openai/gpt-oss-120b` | $0.002/request |

*Testnet models use flat pricing (no token counting) for simplicity.*

## Testnet Usage

For development and testing without real USDC, use the testnet:

```typescript
import { testnetClient } from '@blockrun/llm';

// Create testnet client (uses Base Sepolia)
const client = testnetClient({ privateKey: '0x...' });

// Chat with testnet model
const response = await client.chat('openai/gpt-oss-20b', 'Hello!');
console.log(response);

// Check if client is on testnet
console.log(client.isTestnet()); // true
```

### Testnet Setup

1. Get testnet ETH from [Alchemy Base Sepolia Faucet](https://www.alchemy.com/faucets/base-sepolia)
2. Get testnet USDC from [Circle USDC Faucet](https://faucet.circle.com/)
3. Set your wallet key: `export BASE_CHAIN_WALLET_KEY=0x...`

### Available Testnet Models

- `openai/gpt-oss-20b` - $0.001/request (flat price)
- `openai/gpt-oss-120b` - $0.002/request (flat price)

### Manual Testnet Configuration

```typescript
import { LLMClient } from '@blockrun/llm';

// Or configure manually
const client = new LLMClient({
  privateKey: '0x...',
  apiUrl: 'https://testnet.blockrun.ai/api'
});
const response = await client.chat('openai/gpt-oss-20b', 'Hello!');
```

## Usage Examples

### Simple Chat

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();  // Uses BASE_CHAIN_WALLET_KEY (never sent to server)

const response = await client.chat('openai/gpt-4o', 'Explain quantum computing');
console.log(response);

// With system prompt
const response2 = await client.chat('anthropic/claude-sonnet-4', 'Write a haiku', {
  system: 'You are a creative poet.',
});
```

### Smart Routing (ClawRouter)

Save up to 78% on inference costs with intelligent model routing. ClawRouter uses a 14-dimension rule-based scoring algorithm to select the cheapest model that can handle your request (<1ms, 100% local).

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();

// Auto-route to cheapest capable model
const result = await client.smartChat('What is 2+2?');
console.log(result.response);     // '4'
console.log(result.model);        // 'google/gemini-2.5-flash'
console.log(result.routing.tier); // 'SIMPLE'
console.log(`Saved ${(result.routing.savings * 100).toFixed(0)}%`); // 'Saved 78%'

// Routing profiles
const free = await client.smartChat('Hello!', { routingProfile: 'free' });     // Zero cost
const eco = await client.smartChat('Explain AI', { routingProfile: 'eco' });   // Budget optimized
const auto = await client.smartChat('Code review', { routingProfile: 'auto' }); // Balanced (default)
const premium = await client.smartChat('Write a legal brief', { routingProfile: 'premium' }); // Best quality
```

**Routing Profiles:**

| Profile | Description | Best For |
|---------|-------------|----------|
| `free` | NVIDIA free models only | Testing, simple queries |
| `eco` | Budget-optimized | Cost-sensitive workloads |
| `auto` | Intelligent routing (default) | General use |
| `premium` | Best quality models | Critical tasks |

**Tiers:**

| Tier | Example Tasks | Typical Models |
|------|---------------|----------------|
| SIMPLE | Greetings, math, lookups | Gemini Flash, GPT-4o-mini |
| MEDIUM | Explanations, summaries | GPT-4o, Claude Sonnet |
| COMPLEX | Analysis, code generation | GPT-5.2, Claude Opus |
| REASONING | Multi-step logic, planning | o3, DeepSeek Reasoner |

### Full Chat Completion

```typescript
import { LLMClient, type ChatMessage } from '@blockrun/llm';

const client = new LLMClient();  // Uses BASE_CHAIN_WALLET_KEY (never sent to server)

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'How do I read a file in Node.js?' },
];

const result = await client.chatCompletion('openai/gpt-4o', messages);
console.log(result.choices[0].message.content);
```

### List Available Models

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();  // Uses BASE_CHAIN_WALLET_KEY (never sent to server)
const models = await client.listModels();

for (const model of models) {
  console.log(`${model.id}: $${model.inputPrice}/M input`);
}
```

### Multiple Requests

```typescript
import { LLMClient } from '@blockrun/llm';

const client = new LLMClient();  // Uses BASE_CHAIN_WALLET_KEY (never sent to server)

const [gpt, claude, gemini] = await Promise.all([
  client.chat('openai/gpt-4o', 'What is 2+2?'),
  client.chat('anthropic/claude-sonnet-4', 'What is 3+3?'),
  client.chat('google/gemini-2.5-flash', 'What is 4+4?'),
]);
```

## Configuration

```typescript
// Default: reads BASE_CHAIN_WALLET_KEY from environment
const client = new LLMClient();

// Or pass options explicitly
const client = new LLMClient({
  privateKey: '0x...',           // Your wallet key (never sent to server)
  apiUrl: 'https://blockrun.ai/api',   // Optional
  timeout: 60000,                // Optional (ms)
});
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BASE_CHAIN_WALLET_KEY` | Your Base chain wallet private key (for Base) |
| `BLOCKRUN_SOLANA_KEY` | Your Solana wallet secret key - base58 (for Solana) |
| `BLOCKRUN_NETWORK` | Default network: `base` or `solana` (optional, default: base) |
| `BLOCKRUN_API_URL` | API endpoint (optional, default: https://blockrun.ai/api) |

## Error Handling

```typescript
import { LLMClient, APIError, PaymentError } from '@blockrun/llm';

const client = new LLMClient();

try {
  const response = await client.chat('openai/gpt-4o', 'Hello!');
} catch (error) {
  if (error instanceof PaymentError) {
    console.error('Payment failed - check USDC balance');
  } else if (error instanceof APIError) {
    console.error(`API error: ${error.message}`);
  }
}
```

## Testing

### Running Unit Tests

Unit tests do not require API access or funded wallets:

```bash
npm test                          # Run tests in watch mode
npm test run                      # Run tests once
npm test -- --coverage            # Run with coverage report
```

### Running Integration Tests

Integration tests call the production API and require:
- A funded Base wallet with USDC ($1+ recommended)
- `BASE_CHAIN_WALLET_KEY` environment variable set
- Estimated cost: ~$0.05 per test run

```bash
export BASE_CHAIN_WALLET_KEY=0x...
npm test -- test/integration       # Run integration tests only
```

Integration tests are automatically skipped if `BASE_CHAIN_WALLET_KEY` is not set.

## Setting Up Your Wallet

### Base (EVM)
1. Create a wallet on Base (Coinbase Wallet, MetaMask, etc.)
2. Get USDC on Base for API payments
3. Export your private key and set as `BASE_CHAIN_WALLET_KEY`

```bash
# .env
BASE_CHAIN_WALLET_KEY=0x...
```

### Solana
1. Create a Solana wallet (Phantom, Backpack, Solflare, etc.)
2. Get USDC on Solana for API payments
3. Export your secret key and set as `BLOCKRUN_SOLANA_KEY`

```bash
# .env
BLOCKRUN_SOLANA_KEY=...your_base58_secret_key
```

Note: Solana transactions are gasless for the user - the CDP facilitator pays for transaction fees.

## Security

### Private Key Safety

- **Private key stays local**: Your key is only used for signing on your machine
- **No custody**: BlockRun never holds your funds
- **Verify transactions**: All payments are on-chain and verifiable

### Best Practices

**Private Key Management:**
- Use environment variables, never hard-code keys
- Use dedicated wallets for API payments (separate from main holdings)
- Set spending limits by only funding payment wallets with small amounts
- Never commit `.env` files to version control
- Rotate keys periodically

**Input Validation:**
The SDK validates all inputs before API requests:
- Private keys (format, length, valid hex)
- API URLs (HTTPS required for production, HTTP allowed for localhost)
- Model names and parameters (ranges for max\_tokens, temperature, top\_p)

**Error Sanitization:**
API errors are automatically sanitized to prevent sensitive information leaks.

**Monitoring:**
```typescript
const address = client.getWalletAddress();
console.log(`View transactions: https://basescan.org/address/${address}`);
```

**Keep Updated:**
```bash
npm update @blockrun/llm  # Get security patches
```

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import {
  LLMClient,
  testnetClient,
  type ChatMessage,
  type ChatResponse,
  type ChatOptions,
  type Model,
  // Smart routing types
  type SmartChatOptions,
  type SmartChatResponse,
  type RoutingDecision,
  type RoutingProfile,
  type RoutingTier,
  APIError,
  PaymentError,
} from '@blockrun/llm';
```

## Links

- [Website](https://blockrun.ai)
- [Documentation](https://docs.blockrun.ai)
- [GitHub](https://github.com/blockrun/blockrun-llm-ts)
- [Discord](https://discord.gg/blockrun)

## License

MIT
