import { panic } from "better-result";

// The preload imports this owner before denying general subprocess access.
// Keep the captured primitive private: callers can only read baseline objects.
const spawnGit = Bun.spawnSync.bind(Bun);

type OfflineGitReadOperation =
  | { type: "merge-base"; ref: string }
  | { type: "ls-tree"; commit: string; file: string }
  | { type: "show"; commit: string; file: string };

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
    /\p{Cc}/u.test(file) ||
    !file.split("/").every((part) => /^[\w@][\w.@%-]*$/u.test(part))
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

type ReadGitBaselineOptions = {
  root: string;
  base: string;
  file: string;
};

export const readGitBaseline = ({
  root,
  base,
  file,
}: ReadGitBaselineOptions): string | undefined => {
  const commit = readOfflineGit({
    root,
    operation: { type: "merge-base", ref: base },
  }).trim();
  const tree = readOfflineGit({
    root,
    operation: { type: "ls-tree", commit, file },
  });
  if (tree.trim() === "") {
    return undefined;
  }
  return readOfflineGit({ root, operation: { type: "show", commit, file } });
};
