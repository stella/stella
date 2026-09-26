/**
 * What a generator of committed files shares: laying its output out as the
 * repository formatter does, and the write-or-check step it ends with.
 */

import { panic } from "better-result";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..");
const FORMATTER_CONFIG = path.join(REPO_ROOT, ".oxfmtrc.json");

type GeneratedArtifact = { path: string; contents: string };

/** `source` as the repository formatter lays out a `.${extension}` file. */
export const formattedLikeRepository = async (
  source: string,
  extension: string,
): Promise<string> => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "generated-"));
  try {
    const file = path.join(workDir, `output.${extension}`);
    await writeFile(file, source, "utf-8");
    const result = Bun.spawnSync(
      [process.execPath, "--bun", "oxfmt", "-c", FORMATTER_CONFIG, file],
      { cwd: REPO_ROOT, stderr: "inherit", stdout: "ignore" },
    );
    if (result.exitCode !== 0) {
      return panic(`oxfmt failed on the generated ${extension} file`);
    }
    return await readFile(file, "utf-8");
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
};

/**
 * Under `write`, overwrites the committed files; otherwise compares each with
 * what was just generated and names every one that drifted. `matched` says
 * what the files match when none did. The process exit code.
 */
export const writeOrCheckArtifacts = async (
  artifacts: readonly GeneratedArtifact[],
  { matched, write }: { matched: string; write: boolean },
): Promise<number> => {
  if (write) {
    await Promise.all(
      artifacts.map(
        async ({ contents, path: file }) =>
          await writeFile(file, contents, "utf-8"),
      ),
    );
    console.log(`wrote ${String(artifacts.length)} files`);
    return 0;
  }

  const drifted: string[] = [];
  for (const { contents, path: file } of artifacts) {
    const committed = await readFile(file, "utf-8").catch(() => null);
    if (committed !== contents) {
      drifted.push(path.relative(REPO_ROOT, file));
    }
  }
  for (const file of drifted) {
    console.error(`drifted: ${file}`);
  }
  if (drifted.length > 0) {
    console.error("Run with --write.");
    return 1;
  }
  console.log(`${String(artifacts.length)} files match ${matched}`);
  return 0;
};
