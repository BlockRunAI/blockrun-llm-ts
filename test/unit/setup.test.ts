import { describe, it, expect } from 'vitest';
import { setupAgentWallet } from '../../src/setup.js';

describe('Setup Module', () => {
  it('should create LLMClient from auto-detected wallet', () => {
    const client = setupAgentWallet({ silent: true });
    expect(client).toBeDefined();
    const address = client.getWalletAddress();
    expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('should not print when silent', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setupAgentWallet({ silent: true });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
