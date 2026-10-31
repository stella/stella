import { Result } from "better-result";
import * as v from "valibot";

import { sha256 } from "./classification-values";
import { AdmissionError } from "./yaml";

export type SourceProvider = {
  workflows: (repository: string) => string[];
  read: (repository: string, path: string) => string;
  treeDigest: (repository: string) => string;
};

export const SOURCE_CONFIG = v.record(
  v.string(),
  v.strictObject({
    directory: v.pipe(v.string(), v.minLength(1)),
    revision: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  }),
);
// Hooks export repository selectors such as GIT_DIR. None may redirect a
// source read away from its configured checkout or enable implicit fetches.
const gitSourceEnvironment = () => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return {
    ...environment,
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
};

const readGitSource = (directory: string, args: string[]) => {
  const read = Result.try({
    try: () => {
      const process = Bun.spawnSync(["git", "-C", directory, ...args], {
        env: gitSourceEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (process.exitCode !== 0) {
        throw new AdmissionError({ message: "Git source unavailable" });
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(process.stdout);
    },
    catch: (cause) =>
      cause instanceof AdmissionError
        ? cause
        : new AdmissionError({
            message: "source process or UTF-8 decoding failed",
          }),
  });
  if (read.isErr()) {
    throw read.error;
  }
  return read.value;
};

export const resolveGitHead = (directory: string) => {
  const revision = readGitSource(directory, ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new AdmissionError({ message: "candidate HEAD unavailable" });
  }
  return revision;
};

export const createGitProvider = (
  config: v.InferOutput<typeof SOURCE_CONFIG>,
): SourceProvider => {
  const source = (repository: string) => {
    const entry = config[repository];
    if (!entry) {
      throw new AdmissionError({
        message: `unknown source repository: ${repository}`,
      });
    }
    return entry;
  };
  const git = (repository: string, args: string[]) =>
    readGitSource(source(repository).directory, args);
  return {
    workflows: (repository) =>
      git(repository, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        source(repository).revision,
        "--",
        ".github/workflows",
      ])
        .split("\0")
        .filter((path) => /\.ya?ml$/u.test(path)),
    read: (repository, path) =>
      git(repository, ["show", `${source(repository).revision}:${path}`]),
    // No exclusions; policy lives outside candidate repositories. Tree IDs bind
    // file modes, symlinks, every blob and submodule IDs (not submodule contents).
    treeDigest: (repository) =>
      sha256(
        git(repository, [
          "rev-parse",
          `${source(repository).revision}^{tree}`,
        ]).trim(),
      ),
  };
};
