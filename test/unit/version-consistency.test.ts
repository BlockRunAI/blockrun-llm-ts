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
});
