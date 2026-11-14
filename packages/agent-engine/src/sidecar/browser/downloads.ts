import { panic, Result } from "better-result";
import type { BigIntStats } from "node:fs";
import { type FileHandle, lstat, open, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_DOWNLOAD_STAGED_NAME_PATTERN,
  BROWSER_DOWNLOAD_STAGING_FOLDER,
  BROWSER_DOWNLOAD_STOP_REASON,
  type BrowserDownload,
  type BrowserDownloadStopReason,
} from "@stll/api-contract/browser-control";
import { isPathInside } from "@stll/portable-path";

import {
  createWorkspaceFolder,
  NO_FOLLOW_READ_FLAGS,
  openInWorkspace,
  removeWorkspaceFile,
} from "../workspace-file";

/**
 * The one place a file the member's Chrome downloaded for a local run is
 * judged and moved into the run's folder. The extension has Chrome save it
 * under a fresh name in the staging folder of Chrome's download folder and
 * reports where; this checks that it is a regular PDF there, by its bytes,
 * within the size limit, and copies it into the run's folder under the
 * fixed `BROWSER_DOWNLOADS_FOLDER`, with a name made from the one the page
 * suggested and never over an existing file. The file is only read: never
 * opened in an app or executed. The agent never names a path here.
 *
 * Every file made in the run's folder goes through `workspace-file`, which
 * refuses a link at any segment at the moment of the open: the agent can
 * write in that folder, and swapping a folder for a link after a check
 * never sends a write elsewhere.
 *
 * Only a file in the staging folder, under a staged name, is ever removed
 * from Chrome's folder, and only the very file this check opened: that is
 * the file this download created.
 */

/** Where in the run's folder downloaded files go. */
export const BROWSER_DOWNLOADS_FOLDER = "Downloads";

/** A PDF starts with these bytes. */
const PDF_MAGIC = new TextEncoder().encode("%PDF-");

/** UTF-8 bytes kept of a suggested name; leaves room for a suffix and `.pdf`. */
const MAX_NAME_STEM_BYTES = 200;
const FALLBACK_STEM = "download";
/** Suffixes tried on a name collision before a unique one is used. */
const MAX_NAME_ATTEMPTS = 100;
const COPY_CHUNK_BYTES = 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;

const BROWSER_DOWNLOAD_REFUSAL = {
  /** The bytes are not a PDF's, or the extension saw it was not one. */
  notPdf: "not_pdf",
  tooLarge: "too_large",
  /** Too many of the chat's downloads ran at once. */
  tooMany: "too_many",
  /** Chrome did not finish it. */
  interrupted: "interrupted",
  /** Nothing is where Chrome said it saved the file. */
  vanished: "vanished",
  /** Chrome saved it somewhere other than a staging folder it may use. */
  notStaged: "not_staged",
  /** A link stands where the file should be. */
  link: "link",
  notAFile: "not_a_file",
  /** The run's downloads folder cannot be used. */
  folderUnavailable: "folder_unavailable",
  unreadable: "unreadable",
} as const;

type BrowserDownloadRefusal =
  (typeof BROWSER_DOWNLOAD_REFUSAL)[keyof typeof BROWSER_DOWNLOAD_REFUSAL];

/** What the agent learns of one download. */
export type BrowserDownloadOutcome =
  | {
      status: "saved";
      /** `/`-separated, relative to the run's folder. */
      path: string;
      bytes: number;
      sourceUrl: string;
    }
  | {
      status: "refused";
      reason: BrowserDownloadRefusal;
      message: string;
      sourceUrl: string;
    };

const LIMIT_MIB = BROWSER_CONTROL_LIMITS.downloadBytes / (1024 * 1024);

const REFUSAL_MESSAGES = {
  [BROWSER_DOWNLOAD_REFUSAL.notPdf]:
    "The download is not a PDF; only PDFs are saved.",
  [BROWSER_DOWNLOAD_REFUSAL.tooLarge]: `The download is larger than ${String(LIMIT_MIB)} MiB, the most that is saved.`,
  [BROWSER_DOWNLOAD_REFUSAL.tooMany]:
    "Too many downloads ran at once; this one was stopped. Try it again once the others are saved.",
  [BROWSER_DOWNLOAD_REFUSAL.interrupted]:
    "Chrome could not finish the download.",
  [BROWSER_DOWNLOAD_REFUSAL.vanished]:
    "The downloaded file was gone before it could be saved.",
  [BROWSER_DOWNLOAD_REFUSAL.notStaged]:
    "Chrome saved the file somewhere other than where stella expects it, so it was left there.",
  [BROWSER_DOWNLOAD_REFUSAL.link]:
    "A link stood in place of the downloaded file; nothing was saved.",
  [BROWSER_DOWNLOAD_REFUSAL.notAFile]:
    "Something other than a file stood in place of the download; nothing was saved.",
  [BROWSER_DOWNLOAD_REFUSAL.folderUnavailable]: `The chat's ${BROWSER_DOWNLOADS_FOLDER} folder cannot be written to; the file was left in Chrome's downloads.`,
  [BROWSER_DOWNLOAD_REFUSAL.unreadable]:
    "The downloaded file could not be read.",
} as const satisfies Record<BrowserDownloadRefusal, string>;

const refused = (
  reason: BrowserDownloadRefusal,
  sourceUrl: string,
): BrowserDownloadOutcome => ({
  message: REFUSAL_MESSAGES[reason],
  reason,
  sourceUrl,
  status: "refused",
});

const stoppedRefusal = (
  reason: BrowserDownloadStopReason,
): BrowserDownloadRefusal => {
  switch (reason) {
    case BROWSER_DOWNLOAD_STOP_REASON.notPdf:
      return BROWSER_DOWNLOAD_REFUSAL.notPdf;
    case BROWSER_DOWNLOAD_STOP_REASON.tooLarge:
      return BROWSER_DOWNLOAD_REFUSAL.tooLarge;
    case BROWSER_DOWNLOAD_STOP_REASON.tooMany:
      return BROWSER_DOWNLOAD_REFUSAL.tooMany;
    case BROWSER_DOWNLOAD_STOP_REASON.interrupted:
      return BROWSER_DOWNLOAD_REFUSAL.interrupted;
    default:
      reason satisfies never;
      return panic("Unhandled download stop reason");
  }
};

const utf8 = new TextEncoder();

/** The longest prefix of `text` within `maxBytes` of UTF-8, whole characters only. */
const clipUtf8 = (text: string, maxBytes: number): string => {
  let kept = "";
  let bytes = 0;
  for (const character of text) {
    bytes += utf8.encode(character).byteLength;
    if (bytes > maxBytes) {
      break;
    }
    kept += character;
  }
  return kept;
};

/** Whether `character` is a dot or whitespace, which a name may not start or end with. */
const isEdgeFiller = (character: string) =>
  character === "." || character.trim() === "";

/** `text` without dots and whitespace at either end; linear in its length. */
const trimEdgeFillers = (text: string): string => {
  const characters = [...text];
  let start = 0;
  let end = characters.length;
  while (start < end && isEdgeFiller(characters[start] ?? "")) {
    start += 1;
  }
  while (end > start && isEdgeFiller(characters[end - 1] ?? "")) {
    end -= 1;
  }
  return characters.slice(start, end).join("");
};

/**
 * The stem of the name a downloaded PDF is saved under (`<stem>.pdf`), from
 * the name the page suggested: its last segment only, any whitespace run
 * as one space, without control or formatting characters (which can
 * disguise an extension) or characters a file system refuses, without
 * leading or trailing dots and spaces, and bounded.
 */
export const downloadFileStem = (suggested: string): string => {
  const last = suggested.split(/[/\\]/u).at(-1) ?? "";
  const cleaned = last
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, "")
    .replaceAll(/[<>:"|?*]/gu, "_")
    .replace(/\.pdf$/iu, "");
  const trimmed = trimEdgeFillers(
    clipUtf8(trimEdgeFillers(cleaned), MAX_NAME_STEM_BYTES),
  );
  return trimmed === "" ? FALLBACK_STEM : trimmed;
};

const candidateName = (stem: string, attempt: number): string => {
  if (attempt === 1) {
    return `${stem}.pdf`;
  }
  return attempt <= MAX_NAME_ATTEMPTS
    ? `${stem} (${String(attempt)}).pdf`
    : `${stem} (${crypto.randomUUID()}).pdf`;
};

const OPEN_REFUSALS: Readonly<Record<string, BrowserDownloadRefusal>> = {
  ELOOP: BROWSER_DOWNLOAD_REFUSAL.link,
  ENOENT: BROWSER_DOWNLOAD_REFUSAL.vanished,
};

const openRefusal = (cause: unknown): BrowserDownloadRefusal => {
  const code =
    cause instanceof Error && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "";
  return Object.hasOwn(OPEN_REFUSALS, code)
    ? (OPEN_REFUSALS[code] ?? BROWSER_DOWNLOAD_REFUSAL.unreadable)
    : BROWSER_DOWNLOAD_REFUSAL.unreadable;
};

const realpathOrSelf = async (target: string) => {
  const resolved = await Result.tryPromise(async () => await realpath(target));
  return Result.isOk(resolved) ? resolved.value : target;
};

/** Where a reported file may be, as far as this computer can tell. */
type StagingBounds = {
  /** The member's home folder: Chrome saves under it. */
  home: string;
  /** The run's folder: the agent writes there, so no staged file may be. */
  workspaceDir: string;
};

/**
 * The staged file Chrome reported, when it is one: an absolute, normal path
 * under the member's home folder and outside the run's folder, whose folder
 * is a staging folder and whose name is a staged name. Chrome's download
 * folder is the member's setting and is not read here.
 */
const stagedFile = async (
  reported: string,
  { home, workspaceDir }: StagingBounds,
): Promise<string | null> => {
  if (
    !path.isAbsolute(reported) ||
    path.normalize(reported) !== reported ||
    path.basename(path.dirname(reported)) !== BROWSER_DOWNLOAD_STAGING_FOLDER ||
    !BROWSER_DOWNLOAD_STAGED_NAME_PATTERN.test(path.basename(reported))
  ) {
    return null;
  }
  const folders = [workspaceDir, await realpathOrSelf(workspaceDir)];
  const homes = [home, await realpathOrSelf(home)];
  return homes.some((root) => isPathInside(root, reported)) &&
    !folders.some((folder) => isPathInside(folder, reported))
    ? reported
    : null;
};

const lstatOrNull = async (target: string) => {
  const entry = await Result.tryPromise(
    async () => await lstat(target, { bigint: true }),
  );
  return Result.isOk(entry) ? entry.value : null;
};

/** Whether `file` is gone once removed. */
const removeFile = async (file: string): Promise<boolean> =>
  Result.isOk(
    await Result.tryPromise(async () => {
      await rm(file, { force: true });
    }),
  );

/**
 * Removes `file` only when it is still the very file `opened` describes.
 * A staged file that stays is harmless: Chrome's folder keeps it.
 */
const removeIfSame = async (file: string, opened: BigIntStats) => {
  const now = await lstatOrNull(file);
  if (
    now?.isFile() === true &&
    now.dev === opened.dev &&
    now.ino === opened.ino
  ) {
    await removeFile(file);
  }
};

/** Points where a test may act between two steps. */
export type BrowserDownloadSeams = {
  /** Between making sure the downloads folder exists and creating the file. */
  afterFolderCheck?: () => Promise<void>;
};

type Target = { handle: FileHandle; relativePath: string; name: string };

/** Creates the first free name in the run's downloads folder; never replaces a file. */
const createTarget = async (
  workspaceDir: string,
  stem: string,
): Promise<Target | null> => {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS + 1; attempt += 1) {
    const name = candidateName(stem, attempt);
    const relativePath = `${BROWSER_DOWNLOADS_FOLDER}/${name}`;
    // await-in-loop: each name is tried only once the one before is taken.
    const created = await openInWorkspace(
      workspaceDir,
      relativePath,
      "create",
      PRIVATE_FILE_MODE,
    );
    if (Result.isOk(created)) {
      return { handle: created.value, name, relativePath };
    }
    if (created.error.reason !== "exists") {
      return null;
    }
  }
  return null;
};

type Copied = { type: "copied"; bytes: number } | { type: "too_large" };

/** Copies `source` into `target`, stopping once it outgrows the limit. */
const copyBounded = async (
  source: FileHandle,
  target: FileHandle,
): Promise<Copied> => {
  const buffer = new Uint8Array(COPY_CHUNK_BYTES);
  let total = 0;
  for (;;) {
    // await-in-loop: one chunk in memory at a time.
    const { bytesRead } = await source.read(buffer, 0, buffer.length, total);
    if (bytesRead === 0) {
      return { bytes: total, type: "copied" };
    }
    total += bytesRead;
    if (total > BROWSER_CONTROL_LIMITS.downloadBytes) {
      return { type: "too_large" };
    }
    await target.write(buffer, 0, bytesRead);
  }
};

const startsWithPdfMagic = async (source: FileHandle) => {
  const head = new Uint8Array(PDF_MAGIC.length);
  const { bytesRead } = await source.read(head, 0, head.length, 0);
  return (
    bytesRead === PDF_MAGIC.length &&
    PDF_MAGIC.every((byte, index) => head[index] === byte)
  );
};

/**
 * Copies into a target this module created, then closes it. A copy that
 * fails or outgrows the limit is emptied through its own descriptor, so
 * nothing of it stays even when it cannot be removed, then removed while
 * it is still the file created.
 */
const fillTarget = async (
  workspaceDir: string,
  source: FileHandle,
  target: Target,
): Promise<Result<Copied, "unwritable">> => {
  // Read before anything is written: what is removed later must be this file.
  const identity = await Result.tryPromise(
    async () => await target.handle.stat({ bigint: true }),
  );
  if (Result.isError(identity)) {
    // Nothing was written: an empty file whose identity is unknown stays.
    await Result.tryPromise(async () => await target.handle.close());
    return Result.err("unwritable");
  }
  const filled = await Result.tryPromise(async () => {
    const copied = await copyBounded(source, target.handle).catch(
      async (error: unknown) => {
        await target.handle.truncate(0);
        throw error;
      },
    );
    if (copied.type === "too_large") {
      await target.handle.truncate(0);
    }
    return copied;
  });
  const closed = await Result.tryPromise(
    async () => await target.handle.close(),
  );
  if (
    Result.isOk(filled) &&
    Result.isOk(closed) &&
    filled.value.type === "copied"
  ) {
    return Result.ok(filled.value);
  }
  await removeWorkspaceFile(workspaceDir, target.relativePath, identity.value);
  return Result.isOk(filled) && Result.isOk(closed)
    ? Result.ok(filled.value)
    : Result.err("unwritable");
};

/** Judges the opened staged file and copies it into the run's folder. */
const takeOpened = async ({
  file,
  seams,
  source,
  sourceUrl,
  suggestedName,
  workspaceDir,
}: {
  file: string;
  seams: BrowserDownloadSeams;
  source: FileHandle;
  sourceUrl: string;
  suggestedName: string;
  workspaceDir: string;
}): Promise<BrowserDownloadOutcome> => {
  const opened = await source.stat({ bigint: true });
  if (!opened.isFile()) {
    return refused(BROWSER_DOWNLOAD_REFUSAL.notAFile, sourceUrl);
  }
  if (opened.size > BigInt(BROWSER_CONTROL_LIMITS.downloadBytes)) {
    await removeIfSame(file, opened);
    return refused(BROWSER_DOWNLOAD_REFUSAL.tooLarge, sourceUrl);
  }
  if (!(await startsWithPdfMagic(source))) {
    await removeIfSame(file, opened);
    return refused(BROWSER_DOWNLOAD_REFUSAL.notPdf, sourceUrl);
  }
  const folder = await createWorkspaceFolder(
    workspaceDir,
    BROWSER_DOWNLOADS_FOLDER,
  );
  if (Result.isError(folder)) {
    return refused(BROWSER_DOWNLOAD_REFUSAL.folderUnavailable, sourceUrl);
  }
  await seams.afterFolderCheck?.();
  const target = await createTarget(
    workspaceDir,
    downloadFileStem(suggestedName),
  );
  if (target === null) {
    return refused(BROWSER_DOWNLOAD_REFUSAL.folderUnavailable, sourceUrl);
  }
  const filled = await fillTarget(workspaceDir, source, target);
  if (Result.isError(filled)) {
    // The staged file stays: nothing was wrong with it.
    return refused(BROWSER_DOWNLOAD_REFUSAL.folderUnavailable, sourceUrl);
  }
  const result = filled.value;
  switch (result.type) {
    case "too_large":
      // It grew after it was measured.
      await removeIfSame(file, opened);
      return refused(BROWSER_DOWNLOAD_REFUSAL.tooLarge, sourceUrl);
    case "copied":
      await removeIfSame(file, opened);
      return {
        bytes: result.bytes,
        path: target.relativePath,
        sourceUrl,
        status: "saved",
      };
    default:
      result satisfies never;
      return panic("Unhandled download copy");
  }
};

/** Where to take one download, and what bounds where it may come from. */
type BrowserDownloadPlace = StagingBounds & {
  seams?: BrowserDownloadSeams;
};

/**
 * Takes one download the extension reported for a run whose folder is
 * `workspaceDir`: the saved PDF lands in its downloads folder, and anything
 * else is refused with a reason the agent can relay.
 */
export const receiveBrowserDownload = async (
  download: BrowserDownload,
  { home, seams = {}, workspaceDir }: BrowserDownloadPlace,
): Promise<BrowserDownloadOutcome> => {
  const { sourceUrl } = download;
  if (download.outcome === "stopped") {
    return refused(stoppedRefusal(download.reason), sourceUrl);
  }
  const file = await stagedFile(download.path, { home, workspaceDir });
  if (file === null) {
    return refused(BROWSER_DOWNLOAD_REFUSAL.notStaged, sourceUrl);
  }
  const staging = await lstatOrNull(path.dirname(file));
  if (staging === null) {
    return refused(BROWSER_DOWNLOAD_REFUSAL.vanished, sourceUrl);
  }
  // A linked staging folder could point anywhere.
  if (!staging.isDirectory()) {
    return refused(BROWSER_DOWNLOAD_REFUSAL.notStaged, sourceUrl);
  }
  const opened = await Result.tryPromise({
    try: async () => await open(file, NO_FOLLOW_READ_FLAGS),
    catch: (cause) => openRefusal(cause),
  });
  if (Result.isError(opened)) {
    return refused(opened.error, sourceUrl);
  }
  const source = opened.value;
  const taken = await Result.tryPromise(async () => {
    try {
      return await takeOpened({
        file,
        seams,
        source,
        sourceUrl,
        suggestedName: download.suggestedName,
        workspaceDir,
      });
    } finally {
      await source.close();
    }
  });
  return Result.isOk(taken)
    ? taken.value
    : refused(BROWSER_DOWNLOAD_REFUSAL.unreadable, sourceUrl);
};
