/**
 * What a generator of committed files shares: laying its output out as the
 * repository formatter does, and the write-or-check step it ends with.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  formattedArtifactsLikeRepository as formatArtifacts,
  formattedLikeRepository as formatSource,
  type GeneratedArtifact,
} from "../packages/scripts/src/generated-artifact-format.ts";

// `import.meta.dirname` rather than Bun's `import.meta.dir`: ownership.ts
// imports this module and is itself loaded by oxlint.config.ts under Node.
const REPO_ROOT = path.join(import.meta.dirname, "..");

export const formattedArtifactsLikeRepository = async (
  artifacts: readonly GeneratedArtifact[],
): Promise<GeneratedArtifact[]> => formatArtifacts(artifacts, REPO_ROOT);

export const formattedLikeRepository = async (
  source: string,
  extension: string,
): Promise<string> => formatSource(source, extension, REPO_ROOT);

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
