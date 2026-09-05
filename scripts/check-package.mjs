// Test the files and dependency graph consumers actually install, without wallet peers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "blockrun-package-"));
const run = (command, args, cwd = temp) => execFileSync(command, args, { cwd, stdio: "pipe" });
try {
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temp], root));
  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", join(temp, packed.filename)]);
  const consumer = `import { LLMClient, SolanaLLMClient, AnthropicClient } from '@blockrun/llm';
const key = 'brk_live_package_fixture';
const text: Promise<string> = new LLMClient({apiKey:key}).chat('openai/gpt-5.2', 'Hi');
new SolanaLLMClient({apiKey:key}).chat('openai/gpt-5.2', 'Hi');
new AnthropicClient({apiKey:key}).messages.create({model:'anthropic/claude-haiku-4.5',max_tokens:8,messages:[{role:'user',content:'Hi'}]});
void text;
`;
  writeFileSync(join(temp, "consumer.ts"), consumer);
  run(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--strict", "--noEmit", "--module", "nodenext", "--target", "ES2022", "consumer.ts"]);
  for (const [flag, statement] of [["--input-type=module", "import {LLMClient, SolanaLLMClient} from '@blockrun/llm'"], ["--input-type=commonjs", "const {LLMClient, SolanaLLMClient} = require('@blockrun/llm')"]]) {
    const result = run(process.execPath, [flag, "-e", `${statement}; for (const C of [LLMClient,SolanaLLMClient]) { if (new C({apiKey:'brk_live_package_fixture'}).authMode !== 'api-key') throw Error('wrong billing mode'); } console.log('PASS');`]);
    assert.match(result.toString(), /PASS/);
  }
  const installed = JSON.parse(readFileSync(join(temp, "node_modules/@blockrun/llm/package.json")));
  assert.ok(installed.dependencies["@anthropic-ai/sdk"], "Public Anthropic declarations need an installed dependency");
  console.log("PASS: packed SDK installs without optional peers; strict consumer types and ESM/CJS account clients work");
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
