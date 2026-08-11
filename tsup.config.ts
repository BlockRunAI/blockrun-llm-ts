import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: {
    // Inline the declarations derived from '@blockrun/router-core'. It is a
    // devDependency pinned to a GitHub commit and absent from npm, so a
    // shipped `import ... from '@blockrun/router-core'` would be unresolvable
    // in consumer trees and every routing type would degrade to `any`
    // (CONTRIBUTING.md has the release-time check). Everything else (notably
    // '@anthropic-ai/sdk', a real optional dependency consumers can install)
    // stays an external type import.
    resolve: ["@blockrun/router-core"],
  },
  clean: true,
  // Bundle the wallet kernel into both output formats. @blockrun/core
  // publishes ESM-only; leaving it external makes the CJS build emit
  // require("@blockrun/core"), which throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // for every CommonJS consumer at load time. Inlining also freezes the
  // reviewed kernel bytes into dist (no caret-range drift between review
  // and what users run) — the same trade already made for router-core.
  noExternal: ["@blockrun/core"],
  external: [
    "@anthropic-ai/sdk",
    "@solana/web3.js",
    "@solana/spl-token",
    "bs58",
  ],
});
