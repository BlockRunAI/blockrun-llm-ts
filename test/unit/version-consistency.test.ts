/**
 * The package version is declared in two places: package.json (what npm ships)
 * and the VERSION file. They drift quietly — VERSION sat at 3.4.0 while
 * package.json was already on 3.5.1, because nothing compared them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function packageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
  return pkg.version;
}

function versionFile(): string {
  return fs.readFileSync(path.join(repoRoot, "VERSION"), "utf-8").trim();
}

describe("version consistency", () => {
  it("VERSION matches package.json", () => {
    expect(versionFile()).toBe(packageVersion());
  });

  it("the release is recorded in CHANGELOG.md", () => {
    const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain(`[${packageVersion()}]`);
  });

  it("SDK_VERSION matches package.json", async () => {
    // Same drift, third place. client.ts hardcoded "1.5.0" and
    // solana-client.ts hardcoded "0.3.0" while the package was on 3.8.1, so
    // every request identified itself to the gateway as a version that had
    // not shipped in months. Both now read src/version.ts; this pins it.
    const { SDK_VERSION } = await import("../../src/version");
    expect(SDK_VERSION).toBe(packageVersion());
  });

  it("no client hardcodes its own SDK version", () => {
    // Guard the fix, not just the value: re-introducing a local
    // `const SDK_VERSION = "..."` in a client would drift silently again.
    for (const file of ["src/client.ts", "src/solana-client.ts"]) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf-8");
      expect(source, `${file} must import USER_AGENT from ./version`).not.toMatch(
        /const\s+SDK_VERSION\s*=/
      );
    }
  });
});
