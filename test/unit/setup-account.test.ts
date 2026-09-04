import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ solana: null as string | null, base: null as string | null, chain: '', created: [] as string[] }));
vi.mock('node:fs', async () => ({ ...await vi.importActual<typeof import('node:fs')>('node:fs'), readFileSync: () => state.chain }));
vi.mock('../../src/wallet.js', () => ({
  loadWallet: () => state.base,
  getOrCreateWallet: () => { state.created.push('base'); return { privateKey: '0x' + '01'.repeat(32), address: '', isNew: false }; },
  formatWalletMigrationNotice: () => '',
}));
vi.mock('../../src/solana-wallet.js', () => ({
  loadSolanaWallet: () => state.solana,
  getOrCreateSolanaWallet: async () => { state.created.push('solana'); return { privateKey: 'test-solana-key', address: '', isNew: false }; },
  formatSolanaWalletMigrationNotice: async () => '',
}));
import { setupAgentClient } from '../../src/setup';
beforeEach(() => { state.solana = null; state.base = null; state.chain = ''; state.created = []; vi.stubEnv('BLOCKRUN_API_KEY', undefined); });
afterEach(() => vi.unstubAllEnvs());
describe('agent auth and chain selection', () => {
  it('uses account billing without creating either wallet', async () => {
    expect((await setupAgentClient({ apiKey: 'brk_live_test' })).authMode).toBe('api-key');
    expect(state.created).toEqual([]);
  });
  it('defaults new wallets to Solana', async () => { await setupAgentClient(); expect(state.created).toEqual(['solana']); });
  it('preserves a Base-only installation', async () => { state.base = 'exists'; await setupAgentClient(); expect(state.created).toEqual(['base']); });
  it('prefers Solana when both wallets exist and no preference is saved', async () => { state.base = 'exists'; state.solana = 'exists'; await setupAgentClient(); expect(state.created).toEqual(['solana']); });
  it('honors saved and explicit chain selection', async () => {
    state.chain = 'base'; await setupAgentClient(); await setupAgentClient({ chain: 'solana' });
    expect(state.created).toEqual(['base', 'solana']);
  });
});
