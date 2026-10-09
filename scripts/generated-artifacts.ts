/**
 * What a generator of committed files shares: laying its output out as the
 * repository formatter does, and the write-or-check step it ends with.
 */

import { panic } from "better-result";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// `import.meta.dirname` rather than Bun's `import.meta.dir`: ownership.ts
// imports this module and is itself loaded by oxlint.config.ts under Node.
const REPO_ROOT = path.join(import.meta.dirname, "..");
const FORMATTER_CONFIG = path.join(REPO_ROOT, ".oxfmtrc.json");

type GeneratedArtifact = { path: string; contents: string };

/** Format every artifact in one repository-formatter invocation. */
export const formattedArtifactsLikeRepository = async (
  artifacts: readonly GeneratedArtifact[],
): Promise<GeneratedArtifact[]> => {
  if (artifacts.length === 0) {
    return [];
  }
  const workDir = await mkdtemp(path.join(os.tmpdir(), "generated-"));
  try {
    const files = artifacts.map(({ path: file, contents }, index) => ({
      path: file,
      contents,
      temporaryFile: path.join(workDir, `output-${index}${path.extname(file)}`),
    }));
    await Promise.all(
      files.map(async ({ temporaryFile, contents }) =>
        writeFile(temporaryFile, contents, "utf-8"),
      ),
    );
    const result = Bun.spawnSync(
      [process.execPath, "--bun", "oxfmt", "-c", FORMATTER_CONFIG, workDir],
      { cwd: REPO_ROOT, stderr: "inherit", stdout: "ignore" },
    );
    if (result.exitCode !== 0) {
      return panic("oxfmt failed on the generated artifacts");
    }
    return await Promise.all(
      files.map(async ({ path: file, temporaryFile }) => ({
        path: file,
        contents: await readFile(temporaryFile, "utf-8"),
      })),
    );
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
};

/** `source` as the repository formatter lays out a `.${extension}` file. */
export const formattedLikeRepository = async (
  source: string,
  extension: string,
): Promise<string> => {
  const artifacts = await formattedArtifactsLikeRepository([
    { path: `output.${extension}`, contents: source },
  ]);
  return artifacts.at(0)?.contents ?? panic("Missing formatted artifact");
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
