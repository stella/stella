import { panic, Result } from "better-result";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ChatLocalRunStepContentKind } from "@stll/api-contract/chat-local-run-step-content";
import {
  CHAT_LOCAL_RUN_STEP_MAX_BYTES,
  chatLocalRunCallId,
  chatLocalRunImageType,
  type ChatLocalRunStepKind,
} from "@stll/api-contract/chat-local-run-step-output";
import { sha256Hex } from "@stll/sha256/node";

import {
  type HarnessStepOutput,
  stepOutputText,
  utf8Prefix,
} from "../harness/step-output";

/**
 * Where a run's steps leave what they produced, in the store the desktop
 * names in `run.start` (`stepOutputDir`), out of the harness's reach and
 * never derived from the folder the run works in, which may be one the
 * member linked: `<stepOutputDir>/<runId>/<stepKey>`, `stepKey` being the
 * SHA-256 hex of the step's chat call id. A file is its header line,
 * `{"bytes":<n>}` with how many bytes the step produced, then at most its
 * kind's share of them (`CHAT_LOCAL_RUN_STEP_MAX_BYTES`): a command's output,
 * a diff or a subagent's conversation as UTF-8 text, a viewed image as its
 * own bytes. A kept file is what is sent to stella (`step-uploads.ts`). The
 * desktop also reads the same layout to serve a step to a page on this
 * computer, whatever the bytes are, so it bounds an answer by the largest
 * share only: no file written here may hold more than its own.
 */

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_FOLDER_MODE = 0o700;

/** The folder a run's steps are kept in. */
export const stepOutputRunDir = (stepOutputDir: string, runId: string) =>
  path.join(path.resolve(stepOutputDir), runId);

/** The file one step of a run is kept in. */
export const stepOutputPath = ({
  stepOutputDir,
  runId,
  toolCallId,
}: {
  stepOutputDir: string;
  runId: string;
  toolCallId: string;
}) =>
  path.join(
    stepOutputRunDir(stepOutputDir, runId),
    sha256Hex(chatLocalRunCallId(runId, toolCallId, sha256Hex)),
  );

/**
 * What is kept of a step: which kind it is, how many bytes it produced, and
 * those kept.
 */
type KeptStepOutput = {
  kind: ChatLocalRunStepKind;
  totalBytes: number;
  kept: Uint8Array;
};

/**
 * What is kept of a step's text: a whole-character prefix within the cap.
 * `droppedBytes` is what the step produced that was never held here.
 */
export const keptStepText = (
  text: string,
  droppedBytes = 0,
): KeptStepOutput => {
  const bytes = new TextEncoder().encode(text);
  return {
    kind: "text",
    totalBytes: bytes.length + droppedBytes,
    kept: utf8Prefix(bytes, CHAT_LOCAL_RUN_STEP_MAX_BYTES.text),
  };
};

/**
 * What is kept of an image a step viewed, read from the file it names (a
 * relative name against the run's folder), or `null` when nothing is: the
 * name is not a regular file, or its bytes are not an image's
 * (`chatLocalRunImageType`, whatever the file is called). An image is kept
 * whole or not at all: one past the cap keeps only its size, so the step
 * says why it is not shown. No more than the cap is ever read.
 */
export const keptStepImage = async (
  file: string,
  workspaceDir: string,
): Promise<KeptStepOutput | null> => {
  // Opened without waiting: a pipe put where the file was would otherwise
  // hold the run until something wrote to it. What was opened is then
  // checked itself, so nothing but a regular file is ever read. Reading is
  // the access mode of no flag at all, so this one alone opens for reading.
  const handle = await open(
    path.resolve(workspaceDir, file),
    constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      return null;
    }
    const { size } = opened;
    if (size > CHAT_LOCAL_RUN_STEP_MAX_BYTES.image) {
      return { kind: "image", totalBytes: size, kept: new Uint8Array() };
    }
    // A file may grow after its size is read: the buffer bounds what is
    // taken either way.
    const buffer = new Uint8Array(size);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    const kept = buffer.subarray(0, length);
    return chatLocalRunImageType(kept) === null
      ? null
      : { kind: "image", totalBytes: length, kept };
  } finally {
    await handle.close();
  }
};

/**
 * The file a step is kept as: its header line, then its kept bytes. Every
 * kept file is made here, and the desktop serves one without knowing its
 * kind, so more than the kind's cap is refused here, whatever made it.
 */
export const stepOutputFile = ({ kind, totalBytes, kept }: KeptStepOutput) => {
  if (kept.length > CHAT_LOCAL_RUN_STEP_MAX_BYTES[kind]) {
    return panic("A kept step output is past its kind's cap");
  }
  const header = new TextEncoder().encode(
    `${JSON.stringify({ bytes: totalBytes })}\n`,
  );
  const file = new Uint8Array(header.length + kept.length);
  file.set(header);
  file.set(kept, header.length);
  return file;
};

const LINE_FEED = 0x0a;

/** A kept file as read back: what it holds, or why it holds nothing to read. */
export type KeptStepOutputFile =
  | { type: "kept"; totalBytes: number; bytes: Uint8Array }
  /** No file, or a file that was not written here. */
  | { type: "none" }
  /** The file is there and could not be read now. */
  | { type: "unreadable" };

const isMissingFile = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

/** A kept file as it was written: how many bytes the step produced and those kept. */
export const readKeptStepOutput = async (
  file: string,
): Promise<KeptStepOutputFile> => {
  const read = await Result.tryPromise({
    try: async () => await readFile(file),
    catch: (cause) => cause,
  });
  if (Result.isError(read)) {
    return { type: isMissingFile(read.error) ? "none" : "unreadable" };
  }
  const bytes = new Uint8Array(read.value);
  const headerEnd = bytes.indexOf(LINE_FEED);
  const header =
    headerEnd === -1
      ? null
      : Result.try((): unknown =>
          JSON.parse(new TextDecoder().decode(bytes.subarray(0, headerEnd))),
        ).unwrapOr(null);
  const totalBytes =
    typeof header === "object" && header !== null && "bytes" in header
      ? header.bytes
      : null;
  return typeof totalBytes === "number" &&
    Number.isSafeInteger(totalBytes) &&
    totalBytes >= 0
    ? { type: "kept", totalBytes, bytes: bytes.subarray(headerEnd + 1) }
    : { type: "none" };
};

/** What is kept of what a step produced, or `null` when nothing is. */
const keptStepOutput = async (
  output: HarnessStepOutput,
  workspaceDir: string,
): Promise<KeptStepOutput | null> => {
  switch (output.type) {
    case "image":
      return await keptStepImage(output.path, workspaceDir);
    case "conversation":
      return keptStepText(
        stepOutputText(output, workspaceDir),
        output.droppedBytes,
      );
    case "command":
    case "diff":
      return keptStepText(stepOutputText(output, workspaceDir));
    default:
      output satisfies never;
      return panic("Unhandled step output");
  }
};

type KeepStepOutputOptions = {
  /** The run's store, from `run.start`. */
  stepOutputDir: string;
  /** The folder the run works in; the step's paths are read against it. */
  workspaceDir: string;
  runId: string;
  toolCallId: string;
  output: HarnessStepOutput;
};

/**
 * Keep one step's output, to be sent to stella and opened by the member. Written
 * whole under a temporary name and moved into place, so a reader never sees
 * half of it; a step reported twice keeps its last report. A step with
 * nothing to keep (a viewed file that is no image) keeps no file, an earlier
 * report's included. Answers the step's key and what kind it kept, or `null`
 * when it kept nothing.
 */
export const keepStepOutput = async ({
  stepOutputDir,
  workspaceDir,
  runId,
  toolCallId,
  output,
}: KeepStepOutputOptions) => {
  const file = stepOutputPath({ stepOutputDir, runId, toolCallId });
  const temporary = `${file}.${crypto.randomUUID()}.partial`;
  return await Result.tryPromise({
    try: async () => {
      const kept = await keptStepOutput(output, workspaceDir);
      if (kept === null) {
        await rm(file, { force: true });
        return null;
      }
      await mkdir(path.dirname(file), {
        recursive: true,
        mode: PRIVATE_FOLDER_MODE,
      });
      try {
        await writeFile(temporary, stepOutputFile(kept), {
          mode: PRIVATE_FILE_MODE,
          flag: "wx",
        });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      const kind: ChatLocalRunStepContentKind = output.type;
      return { stepKey: path.basename(file), kind };
    },
    catch: (cause) => cause,
  });
};
