import { panic } from "better-result";

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

export const readOfflineGit = ({
  root,
  operation,
}: OfflineGitReadOptions): string => {
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
      `Offline Git ${operation.type} failed: ${result.stderr.toString()}${operation.type === "show" ? "\nBaseline blob must be present locally; hydrate it before the offline check." : ""}`,
    );
  }
  return result.stdout.toString();
};

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
  const contents = new Map<string, string | undefined>();
  return (file: string) => {
    validateObjectPath({ commit, file });
    if (!contents.has(file)) {
      contents.set(
        file,
        files.has(file)
          ? readOfflineGit({ root, operation: { type: "show", commit, file } })
          : undefined,
      );
    }
    return contents.get(file);
  };
};
