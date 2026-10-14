import { panic } from "better-result";

import { sha256Hex } from "@stll/sha256/bun";

// The preload imports this owner before denying general subprocess access.
// Keep the captured primitive private: callers can only read baseline objects.
const spawnGit = Bun.spawnSync.bind(Bun);

type OfflineGitReadOperation =
  | { type: "merge-base"; ref: string }
  | { type: "ls-tree"; commit: string; file: string }
  | { type: "show"; commit: string; file: string }
  | { type: "files"; commit: string };

type OfflineGitReadOptions = {
  root: string;
  operation: OfflineGitReadOperation;
};

const validateRef = (ref: string) => {
  if (!/^[\w][\w./-]*$/u.test(ref) || ref.includes("..")) {
    panic("Invalid offline Git ref");
  }
};

const validateObjectPath = ({
  commit,
  file,
}: {
  commit: string;
  file: string;
}) => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) {
    panic("Invalid offline Git commit");
  }
  if (
    file.includes("..") ||
    file.startsWith("-") ||
    /\p{Cc}/u.test(file) ||
    !file
      .split("/")
      .every((part) => part !== "." && /^[\w@.$-][\w.@%$-]*$/u.test(part))
  ) {
    panic("Invalid offline Git path");
  }
};

const readOfflineGitBytes = ({ root, operation }: OfflineGitReadOptions) => {
  const args = (() => {
    switch (operation.type) {
      case "merge-base":
        validateRef(operation.ref);
        return ["merge-base", "--end-of-options", "HEAD", operation.ref];
      case "ls-tree":
        validateObjectPath(operation);
        return [
          "ls-tree",
          "--name-only",
          operation.commit,
          "--",
          operation.file,
        ];
      case "show":
        validateObjectPath(operation);
        return ["show", `${operation.commit}:${operation.file}`];
      case "files":
        validateObjectPath({ commit: operation.commit, file: "package.json" });
        return ["ls-tree", "-r", "--name-only", operation.commit];
      default: {
        operation satisfies never;
        return panic("Unsupported offline Git operation");
      }
    }
  })();
  const result = spawnGit(["git", "-c", "protocol.allow=never", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      // Override any repository-level per-protocol permission, too.
      GIT_ALLOW_PROTOCOL: "",
    },
  });
  if (result.exitCode !== 0) {
    return panic(
      `ExternalContractBaselineUnavailable: Offline Git ${operation.type} failed: ${result.stderr.toString()}${operation.type === "show" ? "\nBaseline blob must be present locally; hydrate it before the offline check." : ""}`,
    );
  }
  return result.stdout;
};

export const readOfflineGit = (options: OfflineGitReadOptions): string =>
  new TextDecoder().decode(readOfflineGitBytes(options));

type GitBaselineReaderOptions = { root: string; base: string };

export const createGitBaselineReader = ({
  root,
  base,
}: GitBaselineReaderOptions) => {
  const commit = readOfflineGit({
    root,
    operation: { type: "merge-base", ref: base },
  }).trim();
  const files = new Set(
    readOfflineGit({ root, operation: { type: "files", commit } })
      .trim()
      .split("\n"),
  );
  const bytes = new Map<string, Uint8Array | undefined>();
  const contents = new Map<string, string | undefined>();
  const digests = new Map<string, string | undefined>();
  const readBytes = (file: string) => {
    validateObjectPath({ commit, file });
    if (!bytes.has(file)) {
      bytes.set(
        file,
        files.has(file)
          ? readOfflineGitBytes({
              root,
              operation: { type: "show", commit, file },
            })
          : undefined,
      );
    }
    return bytes.get(file);
  };
  const read = (file: string) => {
    if (!contents.has(file)) {
      const value = readBytes(file);
      contents.set(
        file,
        value === undefined ? undefined : new TextDecoder().decode(value),
      );
    }
    return contents.get(file);
  };
  const digest = (file: string) => {
    if (!digests.has(file)) {
      const value = readBytes(file);
      digests.set(file, value === undefined ? undefined : sha256Hex(value));
    }
    return digests.get(file);
  };
  return Object.assign(read, { files: [...files], digest });
};

export const readGitTrackedFiles = (root: string): string[] => {
  const commit = readOfflineGit({
    root,
    operation: { type: "merge-base", ref: "HEAD" },
  }).trim();
  return readOfflineGit({ root, operation: { type: "files", commit } })
    .trim()
    .split("\n");
};
