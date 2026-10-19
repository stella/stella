import { panic } from "better-result";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

// The preload imports this owner before denying general subprocess access.
// Keep the captured primitive private: callers can only read baseline objects.
const spawnGit = Bun.spawnSync.bind(Bun);
const MAX_BLOB_BATCH = 32;

type OfflineGitReadOperation =
  | { type: "merge-base"; ref: string }
  | { type: "working-paths" }
  | { type: "ls-tree"; commit: string; file: string }
  | { type: "show"; commit: string; file: string }
  | { type: "objects"; commit: string }
  | { type: "blobs"; commit: string; files: readonly string[] };

type OfflineGitReadOptions = {
  root: string;
  operation: OfflineGitReadOperation;
};

const validateRef = (ref: string) => {
  if (!/^[\w][\w./-]*$/u.test(ref) || ref.includes("..")) {
    panic("Invalid offline Git ref");
  }
};

const validObjectPath = (file: string) =>
  !(
    file.includes("..") ||
    file.startsWith("-") ||
    /\p{Cc}/u.test(file) ||
    !file
      .split("/")
      .every((part) => part !== "." && /^[\w@.$-][\w.@%$-]*$/u.test(part))
  );

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
  if (!validObjectPath(file)) {
    panic("Invalid offline Git path");
  }
};

const readOfflineGitBytes = ({ root, operation }: OfflineGitReadOptions) => {
  const args = (() => {
    switch (operation.type) {
      case "merge-base":
        validateRef(operation.ref);
        return ["merge-base", "--end-of-options", "HEAD", operation.ref];
      case "working-paths":
        return ["diff", "--name-only", "-z", "HEAD", "--"];
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
      case "blobs":
        if (
          operation.files.length === 0 ||
          operation.files.length > MAX_BLOB_BATCH
        ) {
          panic("Invalid offline Git blob batch size");
        }
        for (const file of operation.files) {
          validateObjectPath({ commit: operation.commit, file });
        }
        return ["cat-file", "--batch"];
      case "objects":
        validateObjectPath({ commit: operation.commit, file: "package.json" });
        return ["ls-tree", "-r", "-z", operation.commit];
      default: {
        operation satisfies never;
        return panic("Unsupported offline Git operation");
      }
    }
  })();
  const result = spawnGit(["git", "-c", "protocol.allow=never", ...args], {
    cwd: root,
    stdin:
      operation.type === "blobs"
        ? new TextEncoder().encode(
            operation.files
              .map((file) => `${operation.commit}:${file}\n`)
              .join(""),
          )
        : "ignore",
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

type ReadBlobBatchOptions = {
  root: string;
  commit: string;
  files: readonly string[];
};
const readBlobBatch = ({ root, commit, files }: ReadBlobBatchOptions) => {
  const output = readOfflineGitBytes({
    root,
    operation: { type: "blobs", commit, files },
  });
  const blobs = new Map<string, Uint8Array>();
  let offset = 0;
  for (const file of files) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) {
      panic(
        `ExternalContractBaselineUnavailable: missing blob header for ${file}`,
      );
    }
    const header = new TextDecoder().decode(output.subarray(offset, newline));
    const parts = header.split(" ");
    const size = Number(parts.at(2));
    if (parts.at(1) !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      panic(
        `ExternalContractBaselineUnavailable: ${file}: ${header}. Baseline blob must be present locally; hydrate it before the offline check.`,
      );
    }
    offset = newline + 1;
    const end = offset + size;
    if (end >= output.byteLength || output.at(end) !== 10) {
      panic(`ExternalContractBaselineUnavailable: truncated blob for ${file}`);
    }
    blobs.set(file, output.subarray(offset, end));
    offset = end + 1;
  }
  if (offset !== output.byteLength) {
    panic("Unexpected offline Git blob batch output");
  }
  return blobs;
};

type GitBlobIdsOptions = { root: string; commit: string };
const snapshotBlobIds = ({ root, commit }: GitBlobIdsOptions) => {
  const objects = new Map<string, string>();
  for (const line of readOfflineGit({
    root,
    operation: { type: "objects", commit },
  })
    .split("\0")
    .filter(Boolean)) {
    const separator = line.indexOf("\t");
    const [mode, type, id] = line.slice(0, separator).split(" ");
    if (
      separator === -1 ||
      mode === undefined ||
      type === undefined ||
      id === undefined ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(id)
    ) {
      panic("Invalid offline Git object inventory");
    }
    if (type === "blob") {
      objects.set(line.slice(separator + 1), id);
    }
  }
  return objects;
};

export const readGitWorkingTreeBlobIds = (root: string) => {
  const commit = readOfflineGit({
    root,
    operation: { type: "merge-base", ref: "HEAD" },
  }).trim();
  const objects = snapshotBlobIds({ root, commit });
  for (const file of readOfflineGit({
    root,
    operation: { type: "working-paths" },
  })
    .split("\0")
    .filter(Boolean)) {
    if (!validObjectPath(file)) {
      panic("Invalid offline Git working-tree path");
    }
    objects.set(file, "");
  }
  const identities = new Map<string, string | undefined>();
  const get = (file: string) => {
    if (identities.has(file)) {
      return identities.get(file);
    }
    if (!objects.has(file)) {
      return undefined;
    }
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) {
      identities.set(file, undefined);
      return undefined;
    }
    const bytes = lstatSync(absolute).isSymbolicLink()
      ? new TextEncoder().encode(readlinkSync(absolute))
      : readFileSync(absolute);
    const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    const hash = new Bun.CryptoHasher("sha1");
    hash.update(header);
    hash.update(bytes);
    const identity = hash.digest("hex");
    identities.set(file, identity);
    return identity;
  };
  return { get, keys: () => objects.keys() };
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
  const objects = snapshotBlobIds({ root, commit });
  const files = new Set(objects.keys());
  const directories = new Map<string, string[]>();
  for (const file of files) {
    if (!validObjectPath(file) || !/\.[cm]?[jt]sx?$/u.test(file)) {
      continue;
    }
    const directory = file.slice(0, file.lastIndexOf("/") + 1);
    const siblings = directories.get(directory) ?? [];
    siblings.push(file);
    directories.set(directory, siblings);
  }
  const bytes = new Map<string, Uint8Array | undefined>();
  const contents = new Map<string, string | undefined>();
  const readBytes = (file: string) => {
    validateObjectPath({ commit, file });
    if (bytes.has(file)) {
      return bytes.get(file);
    }
    if (!files.has(file)) {
      bytes.set(file, undefined);
      return undefined;
    }
    const siblings = directories.get(file.slice(0, file.lastIndexOf("/") + 1));
    if (siblings?.includes(file)) {
      const selected = [
        file,
        ...siblings
          .filter((candidate) => candidate !== file && !bytes.has(candidate))
          .slice(0, MAX_BLOB_BATCH - 1),
      ];
      for (const [name, blob] of readBlobBatch({
        root,
        commit,
        files: selected,
      })) {
        bytes.set(name, blob);
      }
    } else {
      bytes.set(
        file,
        readOfflineGitBytes({
          root,
          operation: { type: "show", commit, file },
        }),
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
  return Object.assign(read, {
    files: [...files],
    blobId: (file: string) => objects.get(file),
    byteLength: (file: string) => readBytes(file)?.byteLength,
  });
};
