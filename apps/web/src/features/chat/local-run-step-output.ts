import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
} from "@tanstack/react-query";
import { Result } from "better-result";
import * as v from "valibot";

import {
  CHAT_LOCAL_RUN_STEP_OUTPUT_HEADERS,
  CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
  chatLocalRunOfCall,
  chatLocalRunStepOutputBridgePath,
} from "@stll/api-contract/chat-local-run-step-output";
import { FetchBoundaryError } from "@stll/errors";
import { sha256Hex } from "@stll/sha256/browser";
import { Temporal } from "@stll/time";

import { chatKeys } from "@/features/chat/chat-query-contract";
import {
  foldLocalRunStepOutput,
  LOCAL_RUN_STEP_OUTPUT_UNREAD,
  type LocalRunStepOutputEvent,
  localRunStepOutputStaleTime,
} from "@/features/chat/local-run-step-output.logic";
import { api } from "@/lib/api";
import {
  desktopBridgeProofHeaders,
  requestDesktopBridge,
} from "@/lib/desktop-bridge";
import { unwrapApiResponse } from "@/lib/errors/api";
import { readQueryResult } from "@/lib/errors/query-result";

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
  const total = header === null ? Number.NaN : Number(header);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
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

/**
 * Read one step's output from stella desktop on this computer: a grant from
 * the API for the run's owner, then the output itself, straight from the
 * desktop's loopback bridge in chunks, never past the cap. Only the run and
 * call ids reach the API.
 *
 * @yields Whether the run is elsewhere or kept nothing, else its size and
 *   then its text as it arrives.
 */
async function* readLocalRunStepOutput({
  callId,
  signal,
}: ReadStepOutputOptions): AsyncGenerator<LocalRunStepOutputEvent> {
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
  const decoder = new TextDecoder();
  let received = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    received += chunk.value.byteLength;
    if (received > CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES) {
      // The desktop never sends more; a page never shows more either.
      await reader.cancel();
      break;
    }
    yield {
      type: "text",
      text: decoder.decode(chunk.value, { stream: true }),
      bytes: chunk.value.byteLength,
    };
    chunk = await reader.read();
  }
  const rest = decoder.decode();
  if (rest !== "") {
    yield { type: "text", text: rest, bytes: 0 };
  }
}

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
  queryOptions({
    queryKey: chatKeys.localRunStepOutput(activeOrganizationId, userId, callId),
    queryFn: streamedQuery({
      streamFn: ({ signal }) => readLocalRunStepOutput({ callId, signal }),
      reducer: foldLocalRunStepOutput,
      initialValue: LOCAL_RUN_STEP_OUTPUT_UNREAD,
    }),
    staleTime: (query) => localRunStepOutputStaleTime(query.state.data),
    retry: false,
  });
