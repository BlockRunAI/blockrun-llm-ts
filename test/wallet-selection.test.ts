import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-wallet-test-"));
  temporaryHomes.push(home);
  return home;
}

async function importWalletModule(home: string) {
  vi.resetModules();
  vi.doMock("os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => home };
  });
  return import("../src/wallet.js");
}

async function importSolanaWalletModule(home: string) {
  vi.resetModules();
  vi.doMock("os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => home };
  });
  return import("../src/solana-wallet.js");
}

afterEach(() => {
  vi.doUnmock("os");
  while (temporaryHomes.length > 0) {
    fs.rmSync(temporaryHomes.pop()!, { recursive: true, force: true });
  }
});

describe("canonical wallet selection", () => {
  it("uses the BlockRun Base wallet instead of a newer provider wallet", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    const provider = path.join(home, ".agentcash");
    const blockrunKey = `0x${"1".repeat(64)}`;
    const providerKey = `0x${"2".repeat(64)}`;
    fs.mkdirSync(blockrun, { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".session"), blockrunKey);
    fs.writeFileSync(path.join(provider, "wallet.json"), JSON.stringify({
      privateKey: providerKey,
      address: "0x0000000000000000000000000000000000000002",
    }));

    const { loadWallet, scanWallets } = await importWalletModule(home);

    expect(scanWallets()).toHaveLength(1);
    expect(loadWallet()).toBe(blockrunKey);
  });

  it("uses the BlockRun Solana wallet instead of a newer provider wallet", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    const provider = path.join(home, ".agentcash");
    const blockrunKey = "canonical-solana-key";
    fs.mkdirSync(blockrun, { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".solana-session"), blockrunKey);
    fs.writeFileSync(path.join(provider, "solana-wallet.json"), JSON.stringify({
      privateKey: "provider-solana-key",
      address: "ProviderAddress",
    }));

    const { loadSolanaWallet, scanSolanaWallets } = await importSolanaWalletModule(home);

    expect(scanSolanaWallets()).toHaveLength(1);
    expect(loadSolanaWallet()).toBe(blockrunKey);
  });
});
