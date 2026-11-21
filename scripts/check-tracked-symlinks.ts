import path from "node:path";

export type TrackedArchiveEntry =
  | { path: string; kind: "file" | "gitlink" }
  | { path: string; kind: "symlink"; target: string };

class TrackedSymlinkInvariantError extends Error {
  override name = "TrackedSymlinkInvariantError";
  readonly _tag = "TrackedSymlinkInvariantError";
}

const gitOutput = async (root: string, args: string[]) => {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Stream the complete stage-aware census; large indexes exceed the default
  // execFileSync buffer. Drain both pipes before inspecting the exit status.
  const [bytes, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new TrackedSymlinkInvariantError(
      JSON.stringify({
        message: "Cannot read tracked archive entries",
        stderr,
      }),
    );
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

export const readTrackedArchiveEntries = async (root: string) => {
  const inventory = await gitOutput(root, ["ls-files", "--stage", "-z"]);
  const entries: TrackedArchiveEntry[] = [];
  const targets = new Map<string, string>();
  for (const record of inventory.split("\0")) {
    if (record === "") {
      continue;
    }
    const match =
      /^(100644|100755|120000|160000) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]+)$/u.exec(
        record,
      );
    const mode = match?.at(1);
    const oid = match?.at(2);
    const filename = match?.at(3);
    if (mode === undefined || oid === undefined || filename === undefined) {
      throw new TrackedSymlinkInvariantError(
        "Tracked archive inventory is malformed or has unresolved merge stages",
      );
    }
    if (mode !== "120000") {
      entries.push({
        path: filename,
        kind: mode === "160000" ? "gitlink" : "file",
      });
      continue;
    }
    let target = targets.get(oid);
    if (target === undefined) {
      target = await gitOutput(root, ["cat-file", "blob", oid]);
      targets.set(oid, target);
    }
    entries.push({ path: filename, kind: "symlink", target });
  }
  return entries;
};

type Resolution =
  | { status: "resolved"; path: string; kind: "file" | "directory" }
  | { status: "invalid"; message: string };

type ResolutionOptions = {
  segments: readonly string[];
  parent: readonly string[];
  active: ReadonlySet<string>;
};

export const trackedSymlinkProblems = (
  entries: readonly TrackedArchiveEntry[],
) => {
  const nodes = new Map(entries.map((entry) => [entry.path, entry]));
  const directories = new Set([""]);
  for (const entry of entries) {
    let directory = path.posix.dirname(entry.path);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  const resolve = ({
    segments,
    parent,
    active,
  }: ResolutionOptions): Resolution => {
    let current = [...parent];
    let kind: "file" | "directory" = "directory";
    for (const segment of segments) {
      if (kind !== "directory") {
        return {
          status: "invalid",
          message: "target traverses a tracked file",
        };
      }
      if (segment === "" || segment === ".") {
        continue;
      }
      if (segment === "..") {
        if (current.length === 0) {
          return { status: "invalid", message: "target leaves the archive" };
        }
        current.pop();
        continue;
      }
      const candidate = [...current, segment].join("/");
      const node = nodes.get(candidate);
      if (node?.kind === "symlink") {
        if (active.has(candidate)) {
          return {
            status: "invalid",
            message: "target contains a symlink cycle",
          };
        }
        if (
          node.target === "" ||
          node.target.includes("\0") ||
          path.posix.isAbsolute(node.target) ||
          path.win32.isAbsolute(node.target)
        ) {
          return {
            status: "invalid",
            message: "target is not a relative archive path",
          };
        }
        const nextActive = new Set(active);
        nextActive.add(candidate);
        const target = resolve({
          segments: node.target.split("/"),
          parent: current,
          active: nextActive,
        });
        if (target.status === "invalid") {
          return target;
        }
        current = target.path === "" ? [] : target.path.split("/");
        kind = target.kind;
        continue;
      }
      if (node?.kind === "file") {
        current.push(segment);
        kind = "file";
        continue;
      }
      if (node?.kind === "gitlink" || directories.has(candidate)) {
        current.push(segment);
        continue;
      }
      return {
        status: "invalid",
        message: "target is missing from the tracked archive",
      };
    }
    return { status: "resolved", path: current.join("/"), kind };
  };

  return entries.flatMap((entry) => {
    if (entry.kind !== "symlink") {
      return [];
    }
    const result = resolve({
      segments: entry.path.split("/"),
      parent: [],
      active: new Set(),
    });
    return result.status === "resolved"
      ? []
      : [{ path: entry.path, target: entry.target, message: result.message }];
  });
};

if (import.meta.main) {
  const entries = await readTrackedArchiveEntries(process.cwd());
  const problems = trackedSymlinkProblems(entries);
  for (const problem of problems) {
    console.error(
      JSON.stringify(problem.path),
      "tracked symlink target",
      JSON.stringify(problem.target),
      problem.message,
    );
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  }
}
