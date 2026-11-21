import { panic } from "better-result";
import os from "node:os";
import path from "node:path";

export type GeneratedArtifact = { path: string; contents: string };

/**
 * Format every artifact as the repository formatter lays out its file type.
 * Each artifact is formatted under a neutral root-level name, so the root
 * bunfig.toml style applies and an ignore pattern that covers the real path
 * cannot leave the output unformatted.
 */
const formatArtifact = async (
  { path: file, contents }: GeneratedArtifact,
  repositoryRoot: string,
): Promise<GeneratedArtifact> => {
  const child = Bun.spawn(
    [
      process.execPath,
      "fmt",
      "--stdin-filepath",
      `generated-artifact${path.extname(file)}`,
    ],
    {
      cwd: repositoryRoot,
      stdin: new Blob([contents]),
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const [formatted, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    return panic(`bun fmt failed on the generated artifact ${file}`);
  }
  return { path: file, contents: formatted };
};

export const formattedArtifactsLikeRepository = async (
  artifacts: readonly GeneratedArtifact[],
  repositoryRoot: string,
): Promise<GeneratedArtifact[]> => {
  const formatted: GeneratedArtifact[] = [];
  const width = os.availableParallelism();
  for (let start = 0; start < artifacts.length; start += width) {
    formatted.push(
      ...(await Promise.all(
        artifacts
          .slice(start, start + width)
          .map(async (artifact) => formatArtifact(artifact, repositoryRoot)),
      )),
    );
  }
  return formatted;
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
