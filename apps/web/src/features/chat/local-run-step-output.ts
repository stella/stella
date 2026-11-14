import {
  type DefaultError,
  experimental_streamedQuery as streamedQuery,
  queryOptions,
} from "@tanstack/react-query";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import {
  CHAT_LOCAL_RUN_STEP_MAX_BYTES,
  CHAT_LOCAL_RUN_STEP_OUTPUT_HEADERS,
  chatLocalRunOfCall,
  type ChatLocalRunStepKind,
  chatLocalRunStepOutputBridgePath,
} from "@stll/api-contract/chat-local-run-step-output";
import { FetchBoundaryError } from "@stll/errors";
import { sha256Hex } from "@stll/sha256/browser";
import { Temporal } from "@stll/time";

import { chatKeys } from "@/features/chat/chat-query-contract";
import {
  foldLocalRunStepOutput,
  LOCAL_RUN_STEP_OUTPUT_UNREAD,
  type LocalRunStepImageView,
  localRunStepImageView,
  type LocalRunStepOutputEvent,
  localRunStepOutputStaleTime,
  type LocalRunStepOutputView,
} from "@/features/chat/local-run-step-output.logic";
import { api } from "@/lib/api";
import {
  desktopBridgeProofHeaders,
  requestDesktopBridge,
} from "@/lib/desktop-bridge";
import { unwrapApiResponse } from "@/lib/errors/api";
import { readQueryResult } from "@/lib/errors/query-result";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

const NOT_FOUND = 404;
/** The bridge is on this computer: a kept step reads well within this. */
const BRIDGE_READ_TIMEOUT_MS = 30_000;

const bridgeRefusalSchema = v.object({
  code: v.picklist(["run_not_here", "step_not_kept", "unauthorized"]),
});

const totalBytesOf = (response: Response) => {
  const header = response.headers.get(
    CHAT_LOCAL_RUN_STEP_OUTPUT_HEADERS.totalBytes,
  );
  // A size the desktop did not state as a whole number of bytes is unknown.
  const total = parseIntegerToken(header, { sign: "unsigned" });
  return Result.isOk(total) ? total.value : null;
};

const bridgeFailure = (response: Response, path: string) =>
  new FetchBoundaryError({
    message: "stella desktop did not hand over the step's output",
    status: response.status,
    statusText: response.statusText,
    url: path,
  });

/**
 * What a 404 from the bridge means: the step was not kept, or (for anything
 * else) the run is not on this computer.
 */
const missingOn = async (response: Response) => {
  const body = await Result.tryPromise(async (): Promise<unknown> => {
    const parsed: unknown = await response.json();
    return parsed;
  });
  const refusal = v.safeParse(
    bridgeRefusalSchema,
    body.isOk() ? body.value : null,
  );
  return refusal.success && refusal.output.code === "step_not_kept"
    ? ({ type: "not-kept" } as const)
    : ({ type: "elsewhere" } as const);
};

type ReadStepOutputOptions = { callId: string; signal: AbortSignal };
type ReadStepOptions = ReadStepOutputOptions & {
  /** What the step is read as: no more than this kind's cap is taken. */
  kind: ChatLocalRunStepKind;
};

/** What reading a kept step reports, in order, before it is given a form. */
type LocalRunStepReadEvent =
  | Exclude<LocalRunStepOutputEvent, { type: "text" }>
  | { type: "bytes"; bytes: Uint8Array };

/**
 * Read what one step kept from stella desktop on this computer: a grant from
 * the API for the run's owner, then the bytes themselves, straight from the
 * desktop's loopback bridge in chunks, never past the cap of the kind it is
 * read as. Only the run and call ids reach the API.
 *
 * @yields Whether the run is elsewhere or kept nothing, else the step's size
 *   and then its bytes as they arrive.
 */
async function* readLocalRunStep({
  callId,
  signal,
  kind,
}: ReadStepOptions): AsyncGenerator<LocalRunStepReadEvent> {
  const runId = chatLocalRunOfCall(callId);
  if (runId === null) {
    yield { type: "not-kept" };
    return;
  }
  const answered = await api.chat["local-runs"]({ runId })[
    "step-output-grant"
  ].get({ fetch: { signal } });
  if (answered.error?.status === NOT_FOUND) {
    yield { type: "not-kept" };
    return;
  }
  const grant = unwrapApiResponse(answered);
  const path = chatLocalRunStepOutputBridgePath(runId, await sha256Hex(callId));
  const proof = await desktopBridgeProofHeaders({
    portSecret: grant.key,
    timestamp: String(
      Math.floor(Temporal.Now.instant().epochMilliseconds / 1000),
    ),
    path,
  });
  const bridged = await requestDesktopBridge({
    path,
    headers: {
      ...proof,
      [CHAT_LOCAL_RUN_STEP_OUTPUT_HEADERS.grantExpiresAt]: String(
        grant.expiresAt,
      ),
    },
    signal,
    timeout: { type: "total", ms: BRIDGE_READ_TIMEOUT_MS },
  });
  if (bridged.isErr()) {
    yield { type: "elsewhere" };
    return;
  }
  const response = bridged.value;
  if (response.status === NOT_FOUND) {
    yield await missingOn(response);
    return;
  }
  const totalBytes = totalBytesOf(response);
  if (!response.ok || response.body === null || totalBytes === null) {
    readQueryResult(Result.err(bridgeFailure(response, path)));
    return;
  }
  yield { type: "started", totalBytes };
  const reader = response.body.getReader();
  let received = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    received += chunk.value.byteLength;
    if (received > CHAT_LOCAL_RUN_STEP_MAX_BYTES[kind]) {
      // The computer never keeps more of this kind; a page never shows more
      // either, though the desktop serves any kept step up to the largest.
      await reader.cancel();
      break;
    }
    yield { type: "bytes", bytes: chunk.value };
    chunk = await reader.read();
  }
}

/**
 * One step's kept text (a command's output, a diff, a subagent's
 * conversation), decoded as it arrives.
 *
 * @yields Whether the run is elsewhere or kept nothing, else its size and
 *   then its text as it arrives.
 */
async function* readLocalRunStepOutput(
  options: ReadStepOutputOptions,
): AsyncGenerator<LocalRunStepOutputEvent> {
  const decoder = new TextDecoder();
  for await (const event of readLocalRunStep({ ...options, kind: "text" })) {
    if (event.type !== "bytes") {
      yield event;
      continue;
    }
    yield {
      type: "text",
      text: decoder.decode(event.bytes, { stream: true }),
      bytes: event.bytes.byteLength,
    };
  }
  const rest = decoder.decode();
  if (rest !== "") {
    yield { type: "text", text: rest, bytes: 0 };
  }
}

/**
 * The image one step viewed, read whole: part of an image shows nothing, so
 * it is given a form only once every kept byte arrived.
 */
const readLocalRunStepImage = async (
  options: ReadStepOutputOptions,
): Promise<LocalRunStepImageView> => {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const event of readLocalRunStep({ ...options, kind: "image" })) {
    switch (event.type) {
      case "elsewhere":
        return { status: "elsewhere" };
      case "not-kept":
        return { status: "not-kept" };
      case "started":
        totalBytes = event.totalBytes;
        break;
      case "bytes":
        chunks.push(event.bytes);
        break;
      default:
        event satisfies never;
        return panic("Unhandled step read event");
    }
  }
  return localRunStepImageView({ chunks, totalBytes });
};

type LocalRunStepOutputKey = {
  activeOrganizationId: string;
  userId: string;
  callId: string;
};

/**
 * One step's output, read progressively from this computer. A read that
 * reached the desktop holds for good (a finished step's output does not
 * change, so it is never polled); one that found the run elsewhere is read
 * again when the row opens again, since stella desktop may have started
 * since.
 */
export const localRunStepOutputOptions = ({
  activeOrganizationId,
  userId,
  callId,
}: LocalRunStepOutputKey) =>
  // The output is read from the member's computer, never from a stella
  // resource, so no write of stella's makes it stale.
  resourceQueryOptions(
    // Named, so the stale time below reads the output's own type.
    queryOptions<
      LocalRunStepOutputView,
      DefaultError,
      LocalRunStepOutputView,
      ReturnType<typeof chatKeys.localRunStepOutput>
    >({
      queryKey: chatKeys.localRunStepOutput({
        activeOrganizationId,
        userId,
        callId,
      }),
      queryFn: streamedQuery({
        streamFn: ({ signal }) => readLocalRunStepOutput({ callId, signal }),
        reducer: foldLocalRunStepOutput,
        initialValue: LOCAL_RUN_STEP_OUTPUT_UNREAD,
      }),
      staleTime: (query) => localRunStepOutputStaleTime(query.state.data),
      retry: false,
    }),
    { type: "independent" },
  );

/**
 * The image one step viewed, read whole from this computer. It holds as a
 * step's text does: for good once the desktop answered, and read again when
 * the run was found elsewhere.
 */
export const localRunStepImageOptions = ({
  activeOrganizationId,
  userId,
  callId,
}: LocalRunStepOutputKey) =>
  resourceQueryOptions(
    queryOptions<
      LocalRunStepImageView,
      DefaultError,
      LocalRunStepImageView,
      ReturnType<typeof chatKeys.localRunStepImage>
    >({
      queryKey: chatKeys.localRunStepImage({
        activeOrganizationId,
        userId,
        callId,
      }),
      queryFn: async ({ signal }) =>
        await readLocalRunStepImage({ callId, signal }),
      staleTime: (query) => localRunStepOutputStaleTime(query.state.data),
      retry: false,
    }),
    { type: "independent" },
  );
