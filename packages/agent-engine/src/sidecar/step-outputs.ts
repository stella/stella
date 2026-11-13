import { Result } from "better-result";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
  chatLocalRunCallId,
} from "@stll/api-contract/chat-local-run-step-output";
import { sha256Hex } from "@stll/sha256/node";

import { type HarnessStepOutput, stepOutputText } from "../harness/step-output";

/**
 * Where a run's steps leave what they produced, in the store the desktop
 * names in `run.start` (`stepOutputDir`), out of the harness's reach and
 * never derived from the folder the run works in, which may be one the
 * member linked: `<stepOutputDir>/<runId>/<stepKey>`, `stepKey` being the
 * SHA-256 hex of the step's chat call id. A file is its header line,
 * `{"bytes":<n>}` with how many UTF-8 bytes the step produced, then at most
 * `CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES` of them. The desktop reads the same
 * layout to serve a step to a page on this computer.
 */

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_FOLDER_MODE = 0o700;

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
    path.resolve(stepOutputDir),
    runId,
    sha256Hex(chatLocalRunCallId(runId, toolCallId, sha256Hex)),
  );

const isContinuationByte = (byte: number | undefined) =>
  byte !== undefined && byte >= 0x80 && byte < 0xc0;

/** At most `max` bytes of UTF-8 `bytes`, never half of a character. */
const utf8Prefix = (bytes: Uint8Array, max: number) => {
  if (bytes.length <= max) {
    return bytes;
  }
  let end = max;
  while (end > 0 && isContinuationByte(bytes[end])) {
    end -= 1;
  }
  return bytes.subarray(0, end);
};

/** The file a step's text is kept as: its header line, then its kept bytes. */
export const stepOutputFile = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(
    `${JSON.stringify({ bytes: bytes.length })}\n`,
  );
  const kept = utf8Prefix(bytes, CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES);
  const file = new Uint8Array(header.length + kept.length);
  file.set(header);
  file.set(kept, header.length);
  return file;
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
 * Keep one step's output for the member to open on this computer. Written
 * whole under a temporary name and moved into place, so a reader never sees
 * half of it; a step reported twice keeps its last report.
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
      await mkdir(path.dirname(file), {
        recursive: true,
        mode: PRIVATE_FOLDER_MODE,
      });
      try {
        await writeFile(
          temporary,
          stepOutputFile(stepOutputText(output, workspaceDir)),
          { mode: PRIVATE_FILE_MODE, flag: "wx" },
        );
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    catch: (cause) => cause,
  });
};
