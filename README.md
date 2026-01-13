# @blockrun/llm

Pay-per-request access to GPT-4o, Claude 4, Gemini 2.5, and more via x402 micropayments on Base and Solana.

**Networks:** Base (Chain ID: 8453) and Solana Mainnet
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
| `openai/gpt-5.1` | $1.25/M | $10.00/M |
| `openai/gpt-5` | $1.25/M | $10.00/M |
| `openai/gpt-5-mini` | $0.25/M | $2.00/M |
| `openai/gpt-5-nano` | $0.05/M | $0.40/M |
| `openai/gpt-5.2-pro` | $21.00/M | $168.00/M |
| `openai/gpt-5-pro` | $15.00/M | $120.00/M |

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
| `anthropic/claude-opus-4` | $15.00/M | $75.00/M |
| `anthropic/claude-sonnet-4` | $3.00/M | $15.00/M |
| `anthropic/claude-haiku-4.5` | $1.00/M | $5.00/M |

### Google Gemini
| Model | Input Price | Output Price |
|-------|-------------|--------------|
| `google/gemini-3-pro-preview` | $2.00/M | $12.00/M |
| `google/gemini-2.5-pro` | $1.25/M | $10.00/M |
| `google/gemini-2.5-flash` | $0.15/M | $0.60/M |

### Image Generation
| Model | Price |
|-------|-------|
| `openai/dall-e-3` | $0.04-0.08/image |
| `openai/gpt-image-1` | $0.02-0.04/image |
| `google/nano-banana` | $0.05/image |
| `google/nano-banana-pro` | $0.10-0.15/image |
| `black-forest/flux-1.1-pro` | $0.04/image |

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
  type ChatMessage,
  type ChatResponse,
  type ChatOptions,
  type Model,
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
