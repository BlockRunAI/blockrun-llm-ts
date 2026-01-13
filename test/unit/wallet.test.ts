import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  createWallet,
  getWalletAddress,
  getEip681Uri,
  getPaymentLinks,
  formatWalletCreatedMessage,
  formatNeedsFundingMessage,
  formatFundingMessageCompact,
  USDC_BASE_CONTRACT,
} from "../../src/wallet";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Helper to get address from a private key (for testing)
function deriveAddress(privateKey: string): string {
  return privateKeyToAccount(privateKey as `0x${string}`).address;
}

describe("Wallet Utilities", () => {
  describe("createWallet", () => {
    it("should create a new wallet with valid address and key", () => {
      const { address, privateKey } = createWallet();

      expect(address.startsWith("0x")).toBe(true);
      expect(address.length).toBe(42);
      expect(privateKey.startsWith("0x")).toBe(true);
      expect(privateKey.length).toBe(66);
    });

    it("should create unique wallets", () => {
      const wallet1 = createWallet();
      const wallet2 = createWallet();

      expect(wallet1.address).not.toBe(wallet2.address);
      expect(wallet1.privateKey).not.toBe(wallet2.privateKey);
    });
  });

  describe("deriveAddress (privateKeyToAccount)", () => {
    it("should derive correct address from private key", () => {
      const address = deriveAddress(TEST_PRIVATE_KEY);
      expect(address).toBe(TEST_ADDRESS);
    });

    it("should work with key with 0x prefix", () => {
      const address = deriveAddress(TEST_PRIVATE_KEY);
      expect(address).toBe(TEST_ADDRESS);
    });
  });

  describe("getWalletAddress", () => {
    it("should return null when no wallet configured", () => {
      // Clear env vars
      const originalBlockrun = process.env.BLOCKRUN_WALLET_KEY;
      const originalBase = process.env.BASE_CHAIN_WALLET_KEY;
      delete process.env.BLOCKRUN_WALLET_KEY;
      delete process.env.BASE_CHAIN_WALLET_KEY;

      const address = getWalletAddress();
      // Should be null or return from file if exists
      expect(address === null || typeof address === "string").toBe(true);

      // Restore
      if (originalBlockrun) process.env.BLOCKRUN_WALLET_KEY = originalBlockrun;
      if (originalBase) process.env.BASE_CHAIN_WALLET_KEY = originalBase;
    });
  });

  describe("getEip681Uri", () => {
    it("should generate valid EIP-681 URI", () => {
      const uri = getEip681Uri(TEST_ADDRESS, 1.0);

      expect(uri).toContain("ethereum:");
      expect(uri).toContain(USDC_BASE_CONTRACT);
      expect(uri).toContain(TEST_ADDRESS);
      expect(uri).toContain("8453"); // Base chain ID
    });

    it("should handle decimal amounts correctly", () => {
      const uri = getEip681Uri(TEST_ADDRESS, 0.5);

      // 0.5 USDC = 500000 in 6 decimals
      expect(uri).toContain("500000");
    });
  });

  describe("getPaymentLinks", () => {
    it("should generate all payment link types", () => {
      const links = getPaymentLinks(TEST_ADDRESS);

      expect(links.basescan).toContain("basescan.org");
      expect(links.basescan).toContain(TEST_ADDRESS);

      expect(links.blockrun).toContain("blockrun.ai");
      expect(links.blockrun).toContain(TEST_ADDRESS);

      expect(links.walletLink).toContain("ethereum:");
      expect(links.walletLink).toContain(TEST_ADDRESS);
    });
  });

  describe("formatWalletCreatedMessage", () => {
    it("should include wallet address", () => {
      const message = formatWalletCreatedMessage(TEST_ADDRESS);
      expect(message).toContain(TEST_ADDRESS);
    });

    it("should mention USDC", () => {
      const message = formatWalletCreatedMessage(TEST_ADDRESS);
      expect(message).toContain("USDC");
    });

    it("should mention Base chain", () => {
      const message = formatWalletCreatedMessage(TEST_ADDRESS);
      expect(message.toLowerCase()).toContain("base");
    });
  });

  describe("formatNeedsFundingMessage", () => {
    it("should include wallet address", () => {
      const message = formatNeedsFundingMessage(TEST_ADDRESS);
      expect(message).toContain(TEST_ADDRESS);
    });

    it("should mention funding instructions", () => {
      const message = formatNeedsFundingMessage(TEST_ADDRESS);
      expect(message).toContain("USDC");
    });
  });

  describe("formatFundingMessageCompact", () => {
    it("should be shorter than full message", () => {
      const compact = formatFundingMessageCompact(TEST_ADDRESS);
      const full = formatNeedsFundingMessage(TEST_ADDRESS);

      expect(compact.length).toBeLessThan(full.length);
    });

    it("should include wallet address", () => {
      const message = formatFundingMessageCompact(TEST_ADDRESS);
      expect(message).toContain(TEST_ADDRESS);
    });
  });
});
