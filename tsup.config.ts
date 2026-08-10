import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: {
    // Inline the declarations derived from '@blockrun/router-core'. It is a
    // devDependency pinned to a GitHub commit, so a shipped
    // `import ... from '@blockrun/router-core'` would be unresolvable in
    // consumer trees — the same declaration gap clawrouter's published .d.ts
    // has. Everything else (notably '@anthropic-ai/sdk', a real optional
    // dependency consumers can install) stays an external type import.
    resolve: ["@blockrun/router-core"],
  },
  clean: true,
  external: [
    "@anthropic-ai/sdk",
    "@solana/web3.js",
    "@solana/spl-token",
    "bs58",
  ],
});
