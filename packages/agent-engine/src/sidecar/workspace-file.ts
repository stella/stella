import { Result } from "better-result";
import { lstatSync } from "node:fs";
import { constants, open } from "node:fs/promises";
import path from "node:path";

/**
 * Reading a file in a run's folder, from this process, which runs outside the
 * agent's sandbox while the agent can write in that folder. A link it planted
 * on the way, or a pipe swapped in for the file, must not make this process
 * read something else or wait.
 */

/** Why a file in the run's folder was not read. */
export type WorkspaceFileRefusal =
  "link" | "not_a_file" | "too_large" | "unreadable";

export type WorkspaceFileRead =
  | { type: "read"; bytes: Uint8Array }
  | { type: "refused"; reason: WorkspaceFileRefusal };

const refused = (reason: WorkspaceFileRefusal): WorkspaceFileRead => ({
  type: "refused",
  reason,
});

/** A flag the platform has, or none: Windows defines neither of these two. */
const platformFlag = (name: "O_NOFOLLOW" | "O_NONBLOCK") =>
  name in constants ? constants[name] : 0;

/**
 * Read-only is the zero flag, so this is read-only without following a link
 * at the last segment. Non-blocking too: a pipe swapped in for the file would otherwise hold the
 * read open for as long as no one writes to it. Distinct bits, so their sum
 * is their union.
 */
export const NO_FOLLOW_READ_FLAGS =
  platformFlag("O_NOFOLLOW") + platformFlag("O_NONBLOCK");

/** Each folder below `workspaceDir` on the way to the file is a plain folder. */
const parentsRefusal = (
  workspaceDir: string,
  relativePath: string,
): WorkspaceFileRefusal | null => {
  let current = workspaceDir;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    const folder = current;
    const entry = Result.try(() =>
      lstatSync(folder, { throwIfNoEntry: false }),
    );
    if (Result.isError(entry) || entry.value === undefined) {
      return "unreadable";
    }
    if (entry.value.isSymbolicLink()) {
      return "link";
    }
    if (!entry.value.isDirectory()) {
      return "unreadable";
    }
  }
  return null;
};

const isLinkRefusal = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ELOOP";

/**
 * The bytes of the regular file at `relativePath` (`/`-separated), at most
 * `maxBytes`. The last segment opens without following a link, and what was
 * opened is what gets judged and read, so a file swapped after a check is
 * refused too.
 */
export const readWorkspaceFile = async (
  workspaceDir: string,
  relativePath: string,
  maxBytes: number,
): Promise<WorkspaceFileRead> => {
  const parents = parentsRefusal(workspaceDir, relativePath);
  if (parents !== null) {
    return refused(parents);
  }
  const opened = await Result.tryPromise(
    async () =>
      await open(path.join(workspaceDir, relativePath), NO_FOLLOW_READ_FLAGS),
  );
  if (Result.isError(opened)) {
    return refused(isLinkRefusal(opened.error.cause) ? "link" : "unreadable");
  }
  const handle = opened.value;
  // A descriptor that does not close leaves the read in doubt: refused.
  const read = await Result.tryPromise(async (): Promise<WorkspaceFileRead> => {
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        return refused("not_a_file");
      }
      if (stat.size > maxBytes) {
        return refused("too_large");
      }
      const bytes = await handle.readFile();
      return bytes.byteLength > maxBytes
        ? refused("too_large")
        : { type: "read", bytes };
    } finally {
      await handle.close();
    }
  });
  return Result.isOk(read) ? read.value : refused("unreadable");
};
