import { panic } from "better-result";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import {
  generatedFileHash,
  generatedInputIdentity,
  restorePreparedGeneratedSources,
  hasPreparedGeneratedSources,
} from "../packages/scripts/src/prepared-generated-sources";
import { CI_GENERATED_FILES, CI_GENERATION_COMMANDS } from "./generated-files";

const root = new URL("../", import.meta.url).pathname;

const generate = () => {
  for (const command of CI_GENERATION_COMMANDS) {
    const result = Bun.spawnSync([...command], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (childExitStatus(result) !== 0) {
      process.exit(childExitStatus(result));
    }
  }
};

const mode = process.argv.at(2);
if (mode === "produce") {
  const destination =
    process.argv.at(3) ?? panic("Expected generated artifact directory");
  const started = performance.now();
  generate();
  const identity = generatedInputIdentity(root);
  const files = Object.fromEntries(
    CI_GENERATED_FILES.map((file) => {
      const bytes = readFileSync(path.join(root, file));
      const output = path.join(destination, "files", file);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, bytes);
      return [file, generatedFileHash(bytes)];
    }),
  );
  writeFileSync(
    path.join(destination, "manifest.json"),
    JSON.stringify({ ...identity, files }),
  );
  const output = process.env["GITHUB_OUTPUT"];
  if (output) {
    writeFileSync(output, `input_hash=${identity.inputHash}\n`, { flag: "a" });
  }
  console.log(
    `Generated source producer: ${Math.round(performance.now() - started)} ms`,
  );
} else if (mode === "restore") {
  const source =
    process.argv.at(3) ?? panic("Expected downloaded artifact directory");
  const started = performance.now();
  restorePreparedGeneratedSources(root, source);
  console.log(
    `Generated source restore: ${Math.round(performance.now() - started)} ms`,
  );
} else if (mode === "prepare") {
  if (!hasPreparedGeneratedSources(root)) {
    generate();
  }
} else {
  panic("Usage: ci-generated-sources.ts produce|restore <directory> | prepare");
}
