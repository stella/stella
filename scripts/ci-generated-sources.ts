import { panic } from "better-result";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { ciGeneratedFiles } from "../packages/scripts/src/generated-file-inventory";
import { CI_GENERATED_DIRECTORIES } from "../packages/scripts/src/generated-files";
import {
  generatedDirectoryFiles,
  generatedFileHash,
  generatedInputIdentity,
  hasPreparedGeneratedSources,
  requireUnchangedGeneratedInputs,
  restorePreparedGeneratedSources,
} from "../packages/scripts/src/prepared-generated-sources";
import { checkMcpGeneratedTracking } from "./check-mcp-generated-tracking";
import { CI_GENERATION_COMMANDS } from "./generated-files";

const root = fileURLToPath(new URL("../", import.meta.url));

const runSync = (command: readonly string[]) => {
  const result = Bun.spawnSync([...command], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (childExitStatus(result) !== 0) {
    process.exit(childExitStatus(result));
  }
};

const runAsync = async (command: readonly string[]): Promise<number> => {
  const proc = Bun.spawn([...command], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
};

const isParallelCompilerStage = (command: readonly string[]): boolean =>
  command.includes("generate:api-types") ||
  command.includes("generate:typecheck-declarations");

const generate = async () => {
  const parallelStages: (readonly string[])[] = [];
  for (const command of CI_GENERATION_COMMANDS) {
    if (isParallelCompilerStage(command)) {
      parallelStages.push(command);
    } else {
      runSync(command);
    }
  }
  if (parallelStages.length <= 1) {
    for (const command of parallelStages) {
      runSync(command);
    }
    return;
  }
  const codes = await Promise.all(
    parallelStages.map(async (command) => await runAsync(command)),
  );
  const failed = codes.find((code) => code !== 0);
  if (failed !== undefined) {
    process.exit(failed);
  }
};

// Only the producer fills generated directories: a consumer restores them, and
// a local `prepare` leaves them to the checks that need them.
const generateDirectories = async () => {
  const running: Promise<number>[] = [];
  for (const { command } of CI_GENERATED_DIRECTORIES) {
    running.push(runAsync(command));
  }
  const codes = await Promise.all(running);
  const failed = codes.find((code) => code !== 0);
  if (failed !== undefined) {
    process.exit(failed);
  }
};

if (existsSync(path.join(root, ".git"))) {
  checkMcpGeneratedTracking(root);
}
const mode = process.argv.at(2);
if (mode === "produce") {
  const destination =
    process.argv.at(3) ?? panic("Expected generated artifact directory");
  const started = performance.now();
  const identity = generatedInputIdentity(root);
  await Promise.all([generate(), generateDirectories()]);
  requireUnchangedGeneratedInputs(root, identity);
  const files = Object.fromEntries(
    [...ciGeneratedFiles(root), ...generatedDirectoryFiles(root)].map(
      (file) => {
        const bytes = readFileSync(path.join(root, file));
        const output = path.join(destination, "files", file);
        mkdirSync(path.dirname(output), { recursive: true });
        writeFileSync(output, bytes);
        return [file, generatedFileHash(bytes)];
      },
    ),
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
    await generate();
  }
} else {
  panic("Usage: ci-generated-sources.ts produce|restore <directory> | prepare");
}
