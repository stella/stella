import { Result } from "better-result";
import { lstatSync } from "node:fs";
import {
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";

/**
 * Reading and writing files in a run's folder, from this process, which runs
 * outside the agent's sandbox while the agent can write in that folder. A
 * link it planted on the way, even one swapped in after a check, or a pipe
 * swapped in for the file, must not make this process read or write
 * something else, or wait. The one owner of every open in a run's folder:
 * each goes through `openInWorkspace`, which refuses a link at any segment
 * at the moment of the open itself.
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

/** A flag the platform has, or none: Windows defines none of these. */
const platformFlag = (
  name: "O_CREAT" | "O_DIRECTORY" | "O_EXCL" | "O_NOFOLLOW" | "O_NONBLOCK",
) => (name in constants ? constants[name] : 0);

/**
 * Read-only is the zero flag, so this is read-only without following a link
 * at the last segment. Non-blocking too: a pipe swapped in for the file
 * would otherwise hold the read open for as long as no one writes to it.
 * Distinct bits, so their sum is their union.
 */
export const NO_FOLLOW_READ_FLAGS =
  platformFlag("O_NOFOLLOW") + platformFlag("O_NONBLOCK");

/** A new file only: whatever is already there, a link included, refuses. */
const CREATE_FLAGS =
  constants.O_WRONLY +
  platformFlag("O_CREAT") +
  platformFlag("O_EXCL") +
  platformFlag("O_NOFOLLOW");

const FOLDER_FLAGS = platformFlag("O_DIRECTORY") + platformFlag("O_NOFOLLOW");

/**
 * macOS: the open fails when any segment of the path is a link
 * (`O_NOFOLLOW_ANY` in `sys/fcntl.h`), checked by the kernel during the
 * open, so no swap between a check and the open can redirect it.
 */
const DARWIN_NOFOLLOW_ANY = 0x20_00_00_00;

/** What an open in a run's folder is for. */
type WorkspaceOpen = "create" | "read";

const OPEN_FLAGS = {
  create: CREATE_FLAGS,
  read: NO_FOLLOW_READ_FLAGS,
} as const satisfies Record<WorkspaceOpen, number>;

/** Why an open in a run's folder was refused. */
type WorkspaceOpenRefusal = "exists" | "link" | "missing" | "unreadable";

const CODE_REFUSALS: Readonly<Record<string, WorkspaceOpenRefusal>> = {
  EEXIST: "exists",
  ELOOP: "link",
  ENOENT: "missing",
};

const openRefusal = (cause: unknown): WorkspaceOpenRefusal => {
  const code =
    cause instanceof Error && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "";
  return Object.hasOwn(CODE_REFUSALS, code)
    ? (CODE_REFUSALS[code] ?? "unreadable")
    : "unreadable";
};

type Opened = Result<FileHandle, { reason: WorkspaceOpenRefusal }>;

const tryOpen = async (
  target: string,
  flags: number,
  mode?: number,
): Promise<Opened> =>
  await Result.tryPromise({
    try: async () => await open(target, flags, mode),
    catch: (cause) => ({ reason: openRefusal(cause) }),
  });

/** The segments of a `/`-separated path inside a folder; `null` when it would leave it. */
const segmentsOf = (relativePath: string): string[] | null => {
  const segments = relativePath.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  )
    ? segments
    : null;
};

/** The run's folder without links, as this process reaches it. */
const resolvedRoot = async (workspaceDir: string) =>
  await Result.tryPromise({
    try: async () => await realpath(workspaceDir),
    catch: () => ({ reason: "unreadable" as const }),
  });

/** A path to `name` inside the folder `folder` holds open (Linux). */
const procPath = (folder: FileHandle, name: string) =>
  `/proc/self/fd/${String(folder.fd)}/${name}`;

/** A refusal at `target` named `link` when a link stands there. */
const linkOrSame = async (target: string, refusal: Opened): Promise<Opened> => {
  const entry = await Result.tryPromise(async () => await lstat(target));
  return Result.isOk(entry) && entry.value.isSymbolicLink()
    ? Result.err({ reason: "link" })
    : refusal;
};

/**
 * Linux: walks from the run's folder one segment at a time, each folder
 * opened without following a link and the next reached through the open
 * one, so a folder swapped for a link after it was opened is never
 * followed. Answers the open parent folder of the last segment.
 */
const openParentLinux = async (
  root: string,
  parents: readonly string[],
): Promise<Opened> => {
  let folder = await tryOpen(root, FOLDER_FLAGS);
  for (const segment of parents) {
    if (Result.isError(folder)) {
      return folder;
    }
    const current = folder.value;
    // await-in-loop: each folder is reached through the one before it.
    const next = await tryOpen(procPath(current, segment), FOLDER_FLAGS);
    // Linux answers a link opened as a folder without following it with
    // ENOTDIR, not ELOOP: look at what stands there to name it.
    const named =
      Result.isError(next) && next.error.reason === "unreadable"
        ? await linkOrSame(procPath(current, segment), next)
        : next;
    await current.close();
    folder = named;
  }
  return folder;
};

/** Each folder below `root` on the way to the file is a plain folder. */
const parentsAreFolders = (
  root: string,
  parents: readonly string[],
): WorkspaceOpenRefusal | null => {
  let current = root;
  for (const segment of parents) {
    current = path.join(current, segment);
    const folder = current;
    const entry = Result.try(() =>
      lstatSync(folder, { throwIfNoEntry: false }),
    );
    if (Result.isError(entry) || entry.value === undefined) {
      return "missing";
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

/**
 * Opens `relativePath` (`/`-separated) inside the run's folder, refusing a
 * link at any segment at the moment of the open: on macOS by the kernel's
 * no-link flag, on Linux by reaching each folder through the one opened
 * before it. Elsewhere (Windows) the folders on the way are checked first,
 * as no other means exists there. `create` makes a new file and never
 * replaces one.
 */
export const openInWorkspace = async (
  workspaceDir: string,
  relativePath: string,
  purpose: WorkspaceOpen,
  mode?: number,
): Promise<Opened> => {
  const segments = segmentsOf(relativePath);
  const root = await resolvedRoot(workspaceDir);
  if (segments === null || Result.isError(root)) {
    return Result.err({ reason: "unreadable" });
  }
  const flags = OPEN_FLAGS[purpose];
  const name = segments.at(-1) ?? "";
  const parents = segments.slice(0, -1);
  if (process.platform === "darwin") {
    return await tryOpen(
      path.join(root.value, ...segments),
      flags + DARWIN_NOFOLLOW_ANY,
      mode,
    );
  }
  if (process.platform === "linux") {
    const parent = await openParentLinux(root.value, parents);
    if (Result.isError(parent)) {
      return parent;
    }
    try {
      return await tryOpen(procPath(parent.value, name), flags, mode);
    } finally {
      await parent.value.close();
    }
  }
  const unsafe = parentsAreFolders(root.value, parents);
  return unsafe === null
    ? await tryOpen(path.join(root.value, ...segments), flags, mode)
    : Result.err({ reason: unsafe });
};

/**
 * Creates the folder `name` directly in the run's folder; one already
 * there counts only when it is a plain folder. The run's folder itself is
 * reached without links, and `mkdir` never follows one at the new name.
 */
export const createWorkspaceFolder = async (
  workspaceDir: string,
  name: string,
): Promise<Result<void, { reason: WorkspaceOpenRefusal }>> => {
  const root = await resolvedRoot(workspaceDir);
  if (segmentsOf(name)?.length !== 1 || Result.isError(root)) {
    return Result.err({ reason: "unreadable" });
  }
  const folder = path.join(root.value, name);
  const made = await Result.tryPromise({
    try: async () => {
      await mkdir(folder, { mode: 0o700 });
    },
    catch: (cause) => ({ reason: openRefusal(cause) }),
  });
  if (Result.isOk(made) || made.error.reason !== "exists") {
    return made;
  }
  const entry = await Result.tryPromise(async () => await lstat(folder));
  if (Result.isError(entry)) {
    return Result.err({ reason: "unreadable" });
  }
  return entry.value.isDirectory()
    ? Result.ok(undefined)
    : Result.err({ reason: entry.value.isSymbolicLink() ? "link" : "exists" });
};

/** A file's identity: the same device and inode is the same file. */
type WorkspaceFileIdentity = { dev: bigint; ino: bigint };

/** What became of a file asked to be removed from the run's folder. */
export type WorkspaceRemoval =
  /** It is gone. */
  | "removed"
  /** Another file stands at its place now; that one is left alone. */
  | "replaced"
  /** Its place could not be reached without a link, or the removal failed. */
  | "unreachable";

const removalOf = (
  removed: Result<WorkspaceRemoval, unknown>,
): WorkspaceRemoval => (Result.isOk(removed) ? removed.value : "unreachable");

/**
 * Removes the file at `relativePath` only while it is still the file
 * `identity` names, reached the way `openInWorkspace` reaches it. On Linux
 * the removal goes through the open parent folder; elsewhere the check
 * opens the path refusing every link and the removal follows at once, so a
 * link swapped in can only make it keep the file.
 */
export const removeWorkspaceFile = async (
  workspaceDir: string,
  relativePath: string,
  identity: WorkspaceFileIdentity,
): Promise<WorkspaceRemoval> => {
  const segments = segmentsOf(relativePath);
  const root = await resolvedRoot(workspaceDir);
  if (segments === null || Result.isError(root)) {
    return "unreachable";
  }
  const same = (stat: WorkspaceFileIdentity) =>
    stat.dev === identity.dev && stat.ino === identity.ino;
  if (process.platform === "linux") {
    const parent = await openParentLinux(root.value, segments.slice(0, -1));
    if (Result.isError(parent)) {
      return "unreachable";
    }
    try {
      const target = procPath(parent.value, segments.at(-1) ?? "");
      return removalOf(
        await Result.tryPromise(async (): Promise<WorkspaceRemoval> => {
          const stat = await lstat(target, { bigint: true });
          if (!stat.isFile() || !same(stat)) {
            return "replaced";
          }
          await unlink(target);
          return "removed";
        }),
      );
    } finally {
      await parent.value.close();
    }
  }
  const checked = await openInWorkspace(workspaceDir, relativePath, "read");
  if (Result.isError(checked)) {
    return "unreachable";
  }
  return removalOf(
    await Result.tryPromise(async (): Promise<WorkspaceRemoval> => {
      try {
        const stat = await checked.value.stat({ bigint: true });
        if (!stat.isFile() || !same(stat)) {
          return "replaced";
        }
      } finally {
        await checked.value.close();
      }
      await unlink(path.join(root.value, ...segments));
      return "removed";
    }),
  );
};

/**
 * The bytes of the regular file at `relativePath` (`/`-separated), at most
 * `maxBytes`. No link on the way is followed, and what was opened is what
 * gets judged and read, so a file swapped after a check is refused too.
 */
export const readWorkspaceFile = async (
  workspaceDir: string,
  relativePath: string,
  maxBytes: number,
): Promise<WorkspaceFileRead> => {
  const opened = await openInWorkspace(workspaceDir, relativePath, "read");
  if (Result.isError(opened)) {
    return refused(opened.error.reason === "link" ? "link" : "unreadable");
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
