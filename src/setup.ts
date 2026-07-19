/**
 * Agent wallet setup utilities.
 *
 * Convenience functions for agent runtimes (Claude Code skills, etc.)
 * that auto-create wallets and return configured clients.
 */
import { LLMClient } from './client.js';
import { SolanaLLMClient } from './solana-client.js';
import { getOrCreateWallet, formatWalletMigrationNotice } from './wallet.js';
import {
  getOrCreateSolanaWallet,
  formatSolanaWalletMigrationNotice,
} from './solana-wallet.js';

export function setupAgentWallet(options?: {
  silent?: boolean;
}): LLMClient {
  const { address, privateKey, isNew } = getOrCreateWallet();

  if (isNew) {
    // Printed even when silent: `silent` suppresses the welcome banner, and
    // losing sight of a funded wallet is not something to stay quiet about.
    const notice = formatWalletMigrationNotice(address);
    if (notice) console.error(notice);

    if (!options?.silent) {
      console.error(
        `\nBlockRun Agent Wallet Created!\nAddress: ${address}\nSend USDC on Base to get started.\n`
      );
    }
  }

  return new LLMClient({ privateKey });
}

export async function setupAgentSolanaWallet(options?: {
  silent?: boolean;
}): Promise<SolanaLLMClient> {
  const result = await getOrCreateSolanaWallet();

  if (result.isNew) {
    // Printed even when silent, for the same reason as the Base path.
    const notice = await formatSolanaWalletMigrationNotice(result.address);
    if (notice) console.error(notice);

    if (!options?.silent) {
      console.error(
        `\nBlockRun Solana Agent Wallet Created!\nAddress: ${result.address}\nSend USDC on Solana to get started.\n`
      );
    }
  }

  return new SolanaLLMClient({ privateKey: result.privateKey });
}

export async function status(): Promise<{
  address: string;
  balance: number;
}> {
  const client = setupAgentWallet({ silent: true });
  const address = client.getWalletAddress();
  const balance = await client.getBalance();
  console.log(`Wallet: ${address}`);
  console.log(`Balance: $${balance.toFixed(2)} USDC`);
  return { address, balance };
}
