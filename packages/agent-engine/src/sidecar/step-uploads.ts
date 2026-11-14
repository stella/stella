import { panic, Result } from "better-result";
import { mkdir, opendir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import {
  CHAT_LOCAL_RUN_STEP_CONTENT_KINDS,
  type ChatLocalRunStepContentKind,
  chatLocalRunStepContentUploadedSchema,
  chatLocalRunStepContentUploadPath,
  chatLocalRunStepKeySchema,
} from "@stll/api-contract/chat-local-run-step-content";

import { readKeptStepOutput } from "./step-outputs";

/**
 * Sends what a run's steps produced to stella, where it is stored with the
 * conversation. A step's kept file (`step-outputs.ts`) is what is sent; what
 * is still to send is a folder of markers on disk, one small file per step,
 * so nothing waits in memory: a computer that is offline for hours of a run
 * holds a folder of markers, and one step's bytes while they are sent.
 *
 * One step is sent at a time. A step the API settled, or refused for good,
 * leaves the folder; one that could not be sent (no network, the API away, a
 * token being renewed) stays and is sent with the next. The folder is removed
 * when the run ends, sent or not: a run that is over takes nothing more.
 */

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_FOLDER_MODE = 0o700;
/** One step's request; a 10 MiB image on a slow line needs this long. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** A step waiting to be sent, as its marker names it. */
type SpooledStep = {
  /** SHA-256 hex of the step's chat call id. */
  stepKey: string;
  kind: ChatLocalRunStepContentKind;
};

/** What is sent for one step. */
export type StepContentUpload = SpooledStep & {
  /** How many bytes the step produced. */
  totalBytes: number;
  /** The kept bytes; `null` for an image past its cap, which sends its size. */
  content: Uint8Array | null;
};

/**
 * How sending one step ended: `done` once the API settled it or refused it
 * for good (it is not sent again), `retry` when it could not be sent now.
 */
export type StepUploadOutcome = "done" | "retry";

export type UploadStepContent = (
  step: StepContentUpload,
  signal: AbortSignal,
) => Promise<StepUploadOutcome>;

/** Statuses after which the same step may still be stored by a later try. */
const isRetryableStatus = (status: number) =>
  status === 401 || status === 408 || status === 429 || status >= 500;

type StepUploadTarget = {
  /** The stella API origin, from the desktop's own configuration. */
  apiOrigin: string;
  runId: string;
  /** The run's current agent token; `null` once the run holds none. */
  token: () => string | null;
};

/** Puts one step's content to the API with the run's own agent token. */
export const stepContentUploader =
  ({ apiOrigin, runId, token }: StepUploadTarget): UploadStepContent =>
  async ({ stepKey, kind, totalBytes, content }, signal) => {
    const bearer = token();
    if (bearer === null) {
      return "retry";
    }
    const url = new URL(
      chatLocalRunStepContentUploadPath(runId, stepKey),
      apiOrigin,
    );
    url.searchParams.set("kind", kind);
    url.searchParams.set("totalBytes", String(totalBytes));
    const body = new FormData();
    if (content !== null) {
      body.set("content", new File([new Uint8Array(content)], "content"));
    }
    const response = await Result.tryPromise(
      async () =>
        await fetch(url, {
          method: "PUT",
          headers: { authorization: `Bearer ${bearer}` },
          body,
          // A redirect would move the token to another URL.
          redirect: "error",
          signal,
        }),
    );
    if (Result.isError(response)) {
      return "retry";
    }
    if (!response.value.ok) {
      await response.value.body?.cancel();
      return isRetryableStatus(response.value.status) ? "retry" : "done";
    }
    const answer = await Result.tryPromise(
      async (): Promise<unknown> => await response.value.json(),
    );
    // An answer that is not the API's is not a settled step.
    return Result.isOk(answer) &&
      v.safeParse(chatLocalRunStepContentUploadedSchema, answer.value).success
      ? "done"
      : "retry";
  };

const kindSchema = v.picklist(CHAT_LOCAL_RUN_STEP_CONTENT_KINDS);

type StepUploadsOptions = {
  /** The folder of markers, one per step still to send; the run's own. */
  pendingDir: string;
  /** The kept file of a step (`stepOutputPath` by step key). */
  keptFile: (stepKey: string) => string;
  upload: UploadStepContent;
  /** One line in the holder's log; never a step's content. */
  log: (line: string) => void;
};

export type StepUploads = {
  /**
   * Note a kept step as still to send, then send what is waiting, for at
   * most `waitMs`: past it the sending goes on and the caller does not wait.
   */
  send: (step: SpooledStep, waitMs: number) => Promise<void>;
  /** Send what is waiting, for at most `waitMs`. */
  drain: (waitMs: number) => Promise<void>;
  /** End for good: nothing more is sent, and what waited is dropped. */
  close: () => Promise<void>;
};

/** Sends a run's kept steps, one at a time, from a folder of markers. */
export const createStepUploads = ({
  pendingDir,
  keptFile,
  upload,
  log,
}: StepUploadsOptions): StepUploads => {
  const closed = new AbortController();
  /** The sending that is running, if any. */
  let flight: Promise<void> | null = null;
  /** Set by each request to send: a marker may have been written meanwhile. */
  let requested = false;
  /** Whether a request to send came since this was last asked. */
  const takeRequest = () => {
    const was = requested;
    requested = false;
    return was;
  };

  const markerOf = (stepKey: string) => path.join(pendingDir, stepKey);

  /** Send the step one marker names; `retry` leaves the marker. */
  const sendOne = async (stepKey: string): Promise<StepUploadOutcome> => {
    const marker = await readFile(markerOf(stepKey), "utf-8");
    const kind = v.safeParse(kindSchema, marker.trim());
    if (!kind.success) {
      // Not a marker written here: nothing to send for it.
      return "done";
    }
    const kept = await readKeptStepOutput(keptFile(stepKey));
    switch (kept.type) {
      case "none":
        // A marker that names no kept step.
        return "done";
      case "unreadable":
        return "retry";
      case "kept":
        return await upload(
          {
            stepKey,
            kind: kind.output,
            totalBytes: kept.totalBytes,
            // An image is kept whole or not at all: none kept is one past
            // its cap.
            content:
              kind.output === "image" && kept.bytes.length === 0
                ? null
                : kept.bytes,
          },
          AbortSignal.any([
            closed.signal,
            AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          ]),
        );
      default:
        kept satisfies never;
        return panic("Unhandled kept step output");
    }
  };

  /**
   * One pass over the folder, one step at a time. Answers how many steps
   * left it, or `null` when one could not be sent: the API is away, and the
   * rest wait for the next request to send.
   */
  const pass = async (): Promise<number | null> => {
    await mkdir(pendingDir, { recursive: true, mode: PRIVATE_FOLDER_MODE });
    let sent = 0;
    for await (const entry of await opendir(pendingDir)) {
      if (closed.signal.aborted) {
        return null;
      }
      if (!v.is(chatLocalRunStepKeySchema, entry.name)) {
        continue;
      }
      if ((await sendOne(entry.name)) === "retry") {
        return null;
      }
      await rm(markerOf(entry.name), { force: true });
      sent += 1;
    }
    return sent;
  };

  /** Pass until a pass finds nothing left and nothing was queued meanwhile. */
  const sendAll = async () => {
    let sent: number | null;
    do {
      takeRequest();
      sent = await pass();
    } while (sent !== null && (sent > 0 || takeRequest()));
  };

  const fly = async () => {
    const passed = await Result.tryPromise(sendAll);
    flight = null;
    if (Result.isError(passed)) {
      log("sending a run's step content stopped early");
    }
  };

  const drain = async (waitMs: number) => {
    if (closed.signal.aborted) {
      return;
    }
    requested = true;
    flight ??= fly();
    const waited = Promise.withResolvers<null>();
    const timer = setTimeout(() => {
      waited.resolve(null);
    }, waitMs);
    await Promise.race([flight, waited.promise]);
    clearTimeout(timer);
  };

  return {
    send: async ({ stepKey, kind }, waitMs) => {
      if (closed.signal.aborted) {
        return;
      }
      const marked = await Result.tryPromise(async () => {
        await mkdir(pendingDir, { recursive: true, mode: PRIVATE_FOLDER_MODE });
        await writeFile(markerOf(stepKey), kind, { mode: PRIVATE_FILE_MODE });
      });
      if (Result.isError(marked)) {
        log("a step's content could not be queued for sending");
        return;
      }
      await drain(waitMs);
    },
    drain,
    close: async () => {
      closed.abort();
      await flight;
      await rm(pendingDir, { recursive: true, force: true });
    },
  };
};
