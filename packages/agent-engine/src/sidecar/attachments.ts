import { Result, TaggedError } from "better-result";
import { lstatSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { DesktopRunnerAttachment } from "@stll/api-contract/desktop-runner";
import {
  createFetchWithTimeout,
  type Fetcher,
  fetchWithTimeout,
} from "@stll/fetch";
import { iterateBodyWithIdleDeadline } from "@stll/fetch/body-reader";

const HEADERS_TIMEOUT_MS = 30_000;
const BODY_IDLE_TIMEOUT_MS = 30_000;
/** The largest file a chat accepts is well below this; a link cannot fill a disk. */
const MAX_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_FOLDER_MODE = 0o700;

export class AttachmentCopyFailed extends TaggedError("AttachmentCopyFailed")<{
  message: string;
  cause?: unknown;
}> {}

type CopyOptions = {
  fetch?: Fetcher;
  /** Ends a copy in progress when the run is stopped. */
  signal?: AbortSignal;
};

/**
 * Created, never reopened: exclusive creation under a fresh name refuses
 * whatever is already there, and never follows a link.
 */
const STAGED_FILE_FLAGS = "wx";

const failed = (message: string, cause?: unknown) =>
  new AttachmentCopyFailed({ message, cause });

/** What is at `target`, without following a link; `undefined` is nothing. */
const entryAt = (target: string) =>
  Result.try({
    try: () => lstatSync(target, { throwIfNoEntry: false }),
    catch: (cause) => failed("An attachment's place cannot be read.", cause),
  });

/**
 * The agent can write in this folder and this process runs outside its
 * sandbox, so a link planted on the way would send a later copy elsewhere.
 */
const openFolders = async (workspaceDir: string, relativeFolder: string) =>
  await Result.gen(async function* () {
    let current = workspaceDir;
    for (const segment of relativeFolder.split("/")) {
      current = path.join(current, segment);
      const folder = current;
      const entry = yield* entryAt(folder);
      if (entry === undefined) {
        // await-in-loop: each segment is checked before the next is created.
        yield* Result.await(
          Result.tryPromise({
            try: async () => {
              await mkdir(folder, { mode: PRIVATE_FOLDER_MODE });
            },
            catch: (cause) =>
              failed("An attachment's folder cannot be created.", cause),
          }),
        );
      } else if (!entry.isDirectory()) {
        return Result.err(failed("An attachment's folder is not a folder."));
      }
    }
    return Result.ok();
  });

/**
 * Downloads a file beside the run's folder, where the agent cannot write, so
 * nothing it does during a long download can steer where the bytes go.
 */
const stage = async (
  attachment: DesktopRunnerAttachment,
  staged: string,
  request: typeof fetchWithTimeout,
  signal: AbortSignal | undefined,
) =>
  await Result.tryPromise({
    try: async () => {
      const response = await request(attachment.url, {
        redirect: "error",
        signal,
        timeout: { type: "headers", ms: HEADERS_TIMEOUT_MS },
      });
      if (!response.ok) {
        return Result.err(
          failed(`The attachment's link answered ${String(response.status)}.`),
        );
      }
      const file = await open(staged, STAGED_FILE_FLAGS, PRIVATE_FILE_MODE);
      try {
        for await (const chunk of iterateBodyWithIdleDeadline(response, {
          idleMs: BODY_IDLE_TIMEOUT_MS,
          maxBytes: MAX_ATTACHMENT_BYTES,
          signal,
        })) {
          // await-in-loop: backpressure keeps a large file out of memory.
          await file.write(chunk);
        }
      } finally {
        await file.close();
      }
      return Result.ok();
    },
    catch: (cause) => failed("The attachment could not be copied.", cause),
  }).then((outcome) => (Result.isOk(outcome) ? outcome.value : outcome));

/** Moves a staged file to its place, checking the way there last. */
const publish = async (
  attachment: DesktopRunnerAttachment,
  staged: string,
  workspaceDir: string,
) =>
  await Result.gen(async function* () {
    yield* Result.await(
      openFolders(workspaceDir, path.posix.dirname(attachment.path)),
    );
    const target = path.join(workspaceDir, attachment.path);
    if ((yield* entryAt(target)) !== undefined) {
      return Result.err(failed("An attachment's place holds something else."));
    }
    return await Result.tryPromise({
      try: async () => {
        await rename(staged, target);
      },
      catch: (cause) => failed("The attachment could not be moved.", cause),
    });
  });

/**
 * Copies a run's attached files into its folder before the harness starts. A
 * chat's turns share the folder, so a file already there is left as it is: the
 * agent may have worked on it.
 */
export const copyAttachments = async (
  attachments: readonly DesktopRunnerAttachment[],
  workspaceDir: string,
  { fetch: fetcher, signal }: CopyOptions = {},
): Promise<Result<void, AttachmentCopyFailed>> =>
  await Result.gen(async function* () {
    const request =
      fetcher === undefined
        ? fetchWithTimeout
        : createFetchWithTimeout(fetcher);
    for (const attachment of attachments) {
      const existing = yield* entryAt(path.join(workspaceDir, attachment.path));
      if (existing?.isFile() === true) {
        continue;
      }
      if (existing !== undefined) {
        return Result.err(
          failed("An attachment's place holds something else."),
        );
      }
      const staged = path.join(
        path.dirname(workspaceDir),
        `.incoming-${crypto.randomUUID()}`,
      );
      // await-in-loop: copied one at a time to bound memory and bandwidth.
      const copied = await Result.gen(async function* () {
        yield* Result.await(stage(attachment, staged, request, signal));
        return await publish(attachment, staged, workspaceDir);
      });
      if (Result.isError(copied)) {
        const removed = await Result.tryPromise({
          try: async () => {
            await rm(staged, { force: true });
          },
          catch: (cause) => failed("A failed copy was not removed.", cause),
        });
        return Result.isError(removed) ? removed : copied;
      }
    }
    return Result.ok();
  });
