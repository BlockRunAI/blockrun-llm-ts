import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { getOrCreateWallet, getWalletAddress, loadWallet } from "../../src/wallet";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

const PROVIDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
let home: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-wallet-resolution-"));
  vi.stubEnv("BLOCKRUN_HOME", home);
  vi.stubEnv("BLOCKRUN_WALLET_KEY", "");
  vi.stubEnv("BASE_CHAIN_WALLET_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("wallet resolution characterization", () => {
  it("keeps env as the highest-priority source", () => {
    write(path.join(home, ".blockrun", ".session"), PROVIDER_KEY);
    vi.stubEnv("BLOCKRUN_WALLET_KEY", TEST_PRIVATE_KEY);

    expect(getWalletAddress()).toBe(privateKeyToAccount(TEST_PRIVATE_KEY).address);
    expect(getOrCreateWallet().privateKey).toBe(TEST_PRIVATE_KEY);
  });

  it("keeps the newest provider wallet ahead of the BlockRun session", () => {
    write(path.join(home, ".blockrun", ".session"), TEST_PRIVATE_KEY);
    write(
      path.join(home, ".provider", "wallet.json"),
      JSON.stringify({ privateKey: PROVIDER_KEY, address: privateKeyToAccount(PROVIDER_KEY).address }),
    );

    expect(loadWallet()).toBe(PROVIDER_KEY);
  });

  it("keeps session ahead of the legacy wallet file", () => {
    write(path.join(home, ".blockrun", ".session"), TEST_PRIVATE_KEY);
    write(path.join(home, ".blockrun", "wallet.key"), PROVIDER_KEY);

    expect(loadWallet()).toBe(TEST_PRIVATE_KEY);
  });
});
