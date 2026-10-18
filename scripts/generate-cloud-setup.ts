import { panic } from "better-result";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { writeOrCheckArtifacts } from "./generated-artifacts";

// The shared CLI owns policy and rendering. Its isolated input checkout lets
// this output guard verify cloud setup without migrating unrelated toolchains.
export const generateCloudSetupArtifacts = async (root: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-setup-inputs-"));
  const inputs = ["package.json", "stll-toolchain.json", ".node-version"];
  const run = (command: string[]) => {
    const result = Bun.spawnSync(command, {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (childExitStatus(result) !== 0) {
      panic(`Cloud setup generation failed: ${result.stderr.toString()}`);
    }
  };
  try {
    for (const file of inputs) {
      await copyFile(path.join(root, file), path.join(directory, file));
    }
    run(["git", "init", "--quiet"]);
    run(["git", "add", ...inputs]);
    run([
      process.execPath,
      path.join(root, "node_modules/.bin/stll-cloud-setup"),
    ]);
    return await Promise.all(
      [".agents/cloud-setup.sh", ".claude/settings.json"].map(async (file) => ({
        path: path.join(root, file),
        contents: await readFile(path.join(directory, file), "utf-8"),
      })),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  process.exitCode = await writeOrCheckArtifacts(
    await generateCloudSetupArtifacts(root),
    {
      matched: "shared cloud setup policy",
      write: process.argv.includes("--write"),
    },
  );
}
