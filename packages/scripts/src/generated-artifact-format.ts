import { panic } from "better-result";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type GeneratedArtifact = { path: string; contents: string };

/** Format every artifact in one repository-formatter invocation. */
export const formattedArtifactsLikeRepository = async (
  artifacts: readonly GeneratedArtifact[],
  repositoryRoot: string,
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
      [
        process.execPath,
        "--bun",
        "oxfmt",
        "-c",
        path.join(repositoryRoot, ".oxfmtrc.json"),
        workDir,
      ],
      { cwd: repositoryRoot, stderr: "inherit", stdout: "ignore" },
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
  repositoryRoot: string,
): Promise<string> => {
  const artifacts = await formattedArtifactsLikeRepository(
    [{ path: `output.${extension}`, contents: source }],
    repositoryRoot,
  );
  return artifacts.at(0)?.contents ?? panic("Missing formatted artifact");
};
