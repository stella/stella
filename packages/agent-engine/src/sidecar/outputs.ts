import { EventType } from "@tanstack/ai";
import { Result, TaggedError } from "better-result";
import { lstatSync } from "node:fs";
import { constants, open, readdir } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_OUTPUT_EVENT,
  DESKTOP_RUNNER_OUTPUT_MAX_BYTES,
  type DesktopRunnerOutputEvent,
  desktopRunnerOutputPath,
  desktopRunnerOutputUploadedSchema,
} from "@stll/api-contract/desktop-runner";

/**
 * A run's `outputs/` folder is what its agent hands to the member; everything
 * else in the run's folder stays on the computer. The folder is compared with
 * its state when the run started, so a chat's later turn shares only what that
 * turn wrote. A file that cannot be shared stays where it is and is reported;
 * nothing here can fail the run.
 *
 * The agent can write in this folder and this process runs outside its
 * sandbox, so nothing here follows a link: a link planted in the folder, or
 * swapped in on the way to a file, must not read something the agent could not.
 */

export const OUTPUTS_FOLDER = "outputs";

/** How many files one turn shares; the rest stay on the computer. */
export const MAX_RUN_OUTPUT_FILES = 20;
/** How many files beyond the cap are named; a tree of thousands is not listed. */
export const MAX_REPORTED_UNSHARED_OUTPUTS = 20;
/** How much of the folder is read: a dependency tree written here is not walked. */
const MAX_SCANNED_ENTRIES = 5000;
const MAX_FOLDER_DEPTH = 8;
const UPLOAD_TIMEOUT_MS = 120_000;
/** The chat turn waits for these before it ends, so they get a bound together. */
const OUTPUT_SHARING_BUDGET_MS = 5 * 60_000;
const MAX_FILE_NAME_CHARS = 255;

type OutputEntry = {
  kind: "file" | "other";
  size: number;
  mtimeMs: number;
};

/** The folder's entries by path relative to it. */
export type OutputSnapshot = ReadonlyMap<string, OutputEntry>;

/** What is at `target`, without following a link; `undefined` is nothing. */
const entryAt = (target: string) =>
  lstatSync(target, { throwIfNoEntry: false });

const scanFolder = async (
  folder: string,
  relative: string,
  depth: number,
  entries: Map<string, OutputEntry>,
): Promise<void> => {
  const names = await Result.tryPromise(async () => await readdir(folder));
  if (Result.isError(names)) {
    return;
  }
  for (const name of names.value.toSorted()) {
    if (entries.size >= MAX_SCANNED_ENTRIES) {
      return;
    }
    const target = path.join(folder, name);
    const entryPath = relative === "" ? name : `${relative}/${name}`;
    const entry = Result.try(() => entryAt(target));
    if (Result.isError(entry) || entry.value === undefined) {
      continue;
    }
    const stat = entry.value;
    if (stat.isDirectory()) {
      if (depth < MAX_FOLDER_DEPTH) {
        // await-in-loop: one folder at a time, in a stable order, under the cap.
        await scanFolder(target, entryPath, depth + 1, entries);
      }
      continue;
    }
    entries.set(entryPath, {
      kind: stat.isFile() ? "file" : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
};

/** The folder as it stands; empty when it is missing or is not a folder. */
export const snapshotOutputs = async (
  workspaceDir: string,
): Promise<OutputSnapshot> => {
  const entries = new Map<string, OutputEntry>();
  const folder = path.join(workspaceDir, OUTPUTS_FOLDER);
  const root = Result.try(() => entryAt(folder));
  if (Result.isOk(root) && root.value?.isDirectory() === true) {
    await scanFolder(folder, "", 0, entries);
  }
  return entries;
};

const isChanged = (entry: OutputEntry, before: OutputEntry | undefined) =>
  before === undefined ||
  before.kind !== entry.kind ||
  before.size !== entry.size ||
  before.mtimeMs !== entry.mtimeMs;

/** Whether every folder from the outputs folder down to the file is a folder. */
const hasPlainParents = (workspaceDir: string, entryPath: string) => {
  let current = path.join(workspaceDir, OUTPUTS_FOLDER);
  if (entryAt(current)?.isDirectory() !== true) {
    return false;
  }
  for (const segment of entryPath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    if (entryAt(current)?.isDirectory() !== true) {
      return false;
    }
  }
  return true;
};

/**
 * The file's bytes, or `null` when it may not leave the computer. The final
 * segment opens without following a link, and what was opened is what gets
 * judged and read, so a file swapped after the scan is refused too.
 */
const readOutput = async (workspaceDir: string, entryPath: string) => {
  if (!hasPlainParents(workspaceDir, entryPath)) {
    return null;
  }
  // Read-only is the zero flag, so this is read-only without following a link.
  const handle = await open(
    path.join(workspaceDir, OUTPUTS_FOLDER, entryPath),
    constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > DESKTOP_RUNNER_OUTPUT_MAX_BYTES) {
      return null;
    }
    const bytes = await handle.readFile();
    return bytes.byteLength > DESKTOP_RUNNER_OUTPUT_MAX_BYTES ? null : bytes;
  } finally {
    await handle.close();
  }
};

export class OutputUploadFailed extends TaggedError("OutputUploadFailed")<{
  message: string;
  cause?: unknown;
}> {}

/** Sends one file to the API and answers the id it stored it under. */
export type UploadOutput = (
  file: File,
  signal: AbortSignal,
) => Promise<Result<string, OutputUploadFailed>>;

const fileNameOf = (entryPath: string) =>
  path.posix.basename(entryPath).slice(0, MAX_FILE_NAME_CHARS);

const shareOne = async (
  workspaceDir: string,
  entryPath: string,
  upload: UploadOutput,
  signal: AbortSignal,
): Promise<string | null> => {
  const shared = await Result.tryPromise(async () => {
    const bytes = await readOutput(workspaceDir, entryPath);
    if (bytes === null) {
      return null;
    }
    return await upload(
      new File([new Uint8Array(bytes)], fileNameOf(entryPath)),
      AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
    );
  });
  if (Result.isError(shared) || shared.value === null) {
    return null;
  }
  return Result.isOk(shared.value) ? shared.value.value : null;
};

type ShareOutputsOptions = {
  workspaceDir: string;
  /** The folder when the run started. */
  before: OutputSnapshot;
  upload: UploadOutput;
  /** Ends the sharing when the run is stopped: what is left is reported. */
  signal: AbortSignal;
};

/**
 * Upload what the turn wrote to the folder, one file at a time to bound memory
 * and bandwidth, and report each as it settles. Files past the cap and anything
 * that is not a regular file are reported as not shared.
 *
 * @yields One report per file the turn wrote, up to what is named.
 */
export async function* shareOutputs({
  workspaceDir,
  before,
  upload,
  signal,
}: ShareOutputsOptions): AsyncGenerator<DesktopRunnerOutputEvent> {
  const stopped = AbortSignal.any([
    signal,
    AbortSignal.timeout(OUTPUT_SHARING_BUDGET_MS),
  ]);
  const current = await snapshotOutputs(workspaceDir);
  const changed = [...current]
    .filter(([entryPath, entry]) => isChanged(entry, before.get(entryPath)))
    .toSorted(([left], [right]) => (left < right ? -1 : 1));
  let attempted = 0;
  let unnamed = MAX_REPORTED_UNSHARED_OUTPUTS;
  for (const [entryPath, entry] of changed) {
    const fileName = fileNameOf(entryPath);
    const mayUpload =
      entry.kind === "file" &&
      attempted < MAX_RUN_OUTPUT_FILES &&
      !stopped.aborted;
    if (mayUpload) {
      attempted += 1;
      // await-in-loop: one file in memory at a time.
      const fileId = await shareOne(workspaceDir, entryPath, upload, stopped);
      if (fileId !== null) {
        yield { status: "uploaded", fileId, fileName };
        continue;
      }
    }
    if (unnamed > 0) {
      unnamed -= 1;
      yield { status: "failed", fileName };
    }
  }
}

type RunOutputTarget = {
  /** The stella API origin, from the desktop's own configuration. */
  apiOrigin: string;
  runId: string;
  /** The run's current agent token; `null` once the run holds none. */
  token: () => string | null;
};

/** Posts a run's file to the API with the run's own agent token. */
export const runOutputUploader =
  ({ apiOrigin, runId, token }: RunOutputTarget): UploadOutput =>
  async (file, signal) => {
    const bearer = token();
    if (bearer === null) {
      return Result.err(
        new OutputUploadFailed({ message: "The run holds no token." }),
      );
    }
    const body = new FormData();
    body.set("file", file);
    const unreachable = (cause: unknown) =>
      new OutputUploadFailed({ message: "The API did not answer.", cause });
    const response = await Result.tryPromise({
      try: async () =>
        await fetch(new URL(desktopRunnerOutputPath(runId), apiOrigin), {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body,
          // A redirect would move the token to another URL.
          redirect: "error",
          signal,
        }),
      catch: unreachable,
    });
    if (Result.isError(response)) {
      return response;
    }
    if (!response.value.ok) {
      await response.value.body?.cancel();
      return Result.err(
        new OutputUploadFailed({
          message: `The API answered ${String(response.value.status)}.`,
        }),
      );
    }
    const answer = await Result.tryPromise({
      try: async (): Promise<unknown> => await response.value.json(),
      catch: unreachable,
    });
    if (Result.isError(answer)) {
      return answer;
    }
    const uploaded = v.safeParse(
      desktopRunnerOutputUploadedSchema,
      answer.value,
    );
    return uploaded.success
      ? Result.ok(uploaded.output.fileId)
      : Result.err(
          new OutputUploadFailed({ message: "The API named no file." }),
        );
  };

/** A report as the chunk it travels in on the run's stream. */
export const outputReportChunk = (
  value: DesktopRunnerOutputEvent,
  timestamp: number,
) =>
  ({
    type: EventType.CUSTOM,
    name: DESKTOP_RUNNER_OUTPUT_EVENT,
    value,
    timestamp,
  }) as const;
