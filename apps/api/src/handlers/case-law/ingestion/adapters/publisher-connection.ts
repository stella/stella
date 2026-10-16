// parser-output-unchanged: publisher access admission and connection lifetime change request scheduling; successful payload parsing is unchanged.
import { panic, Result } from "better-result";

import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import { evaluatePublisherAccessPolicy } from "@/api/lib/legal-search/publisher-access-policy";
import type { PublisherGateAccess } from "@/api/lib/legal-search/publisher-gates";

import {
  PublisherPacingStopped,
  type createPublisherRequestSlot,
} from "./publisher-request-gate";

// The transport is aborted before its coordination lease can expire, including
// a bounded gate-command margin. A crashed worker relinquishes the slot by TTL.
const CONNECTION_RELEASE_MARGIN_MS = 10_000;
const CONNECTION_RETRY_MS = 250;

type PublisherConnectionOptions = {
  adapterKey: AdapterKey;
  access: PublisherGateAccess;
  slot: ReturnType<typeof createPublisherRequestSlot>;
  signal?: AbortSignal | undefined;
  request: (signal: AbortSignal) => Promise<Response>;
  mode?: "immediate" | undefined;
};

type ConsumeResponseOptions = {
  response: Response;
  maxBytes: number;
  adapterKey: AdapterKey;
  signal: AbortSignal;
};

const consumeResponse = async ({
  response,
  maxBytes,
  adapterKey,
  signal,
}: ConsumeResponseOptions): Promise<Response> => {
  if (response.body === null) {
    signal.throwIfAborted();
    return response;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancellation: Promise<Result<void, unknown>> | undefined;
  const cancel = () =>
    Result.tryPromise({
      try: async () => await reader.cancel(signal.reason),
      catch: (error) => error,
    });
  const abort = () => {
    cancellation = cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  const read = await Result.tryPromise({
    try: async () => {
      for (;;) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > maxBytes) {
          throw new AdapterFetchError({
            message: "Publisher response exceeds the connection byte limit",
            adapterKey,
            cursor: null,
          });
        }
        chunks.push(value);
      }
    },
    catch: (error) => error,
  });
  signal.removeEventListener("abort", abort);
  const cancelled = await (cancellation ?? cancel());
  reader.releaseLock();
  if (read.isErr()) {
    throw read.error;
  }
  if (cancelled.isErr()) {
    throw cancelled.error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const buffered = new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(buffered, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return buffered;
};

/** Hold the shared connection through body EOF, cancellation or transport failure. */
export const runPublisherConnectionRequest = async ({
  adapterKey,
  access,
  slot,
  signal,
  request,
  mode,
}: PublisherConnectionOptions): Promise<Response> => {
  const requireWindow = () => {
    const admission = evaluatePublisherAccessPolicy(
      access.schedule,
      slot.now(),
    );
    switch (admission.type) {
      case "open":
        return admission.closesAt;
      case "closed":
      case "unavailable":
        if (mode === "immediate") {
          throw new PublisherPacingStopped({
            message:
              admission.type === "closed"
                ? "Publisher access window is closed"
                : "Publisher access calendar is unavailable",
            status:
              admission.type === "closed"
                ? "pacing-deferred"
                : "pacing-unavailable",
          });
        }
        throw new AdapterFetchError({
          message:
            admission.type === "closed"
              ? "Publisher access window is closed"
              : "Publisher access calendar is unavailable",
          adapterKey,
          cursor: null,
          stopKind: INGESTION_STOP_KIND.PUBLISHER_REFUSAL,
        });
      default:
        admission satisfies never;
        return panic("Unhandled publisher access admission");
    }
  };
  const token = Bun.randomUUIDv7();
  let connectionDeadline: number;
  for (;;) {
    signal?.throwIfAborted();
    const closesAt = requireWindow();
    const now = slot.now();
    connectionDeadline = Math.min(
      now + access.maxConnectionMs,
      closesAt ?? Infinity,
    );
    if (
      await slot.tryAcquireConnection({
        token,
        holdMs: connectionDeadline - now + CONNECTION_RELEASE_MARGIN_MS,
        signal,
      })
    ) {
      break;
    }
    if (mode === "immediate") {
      throw new PublisherPacingStopped({
        message: "Publisher connection deferred",
        status: "pacing-deferred",
      });
    }
    await slot.sleep(CONNECTION_RETRY_MS, signal);
  }
  const connectionController = new AbortController();
  try {
    requireWindow();
    signal?.throwIfAborted();
    const remainingMs = connectionDeadline - slot.now();
    if (remainingMs <= 0) {
      throw new AdapterFetchError({
        message: "Publisher connection admission expired",
        adapterKey,
        cursor: null,
        stopKind: INGESTION_STOP_KIND.PUBLISHER_REFUSAL,
      });
    }
    const deadlineSignal = AbortSignal.timeout(remainingMs);
    const connectionSignal = AbortSignal.any([
      connectionController.signal,
      deadlineSignal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    const response = await request(connectionSignal);
    return await consumeResponse({
      response,
      maxBytes: access.maxResponseBytes,
      adapterKey,
      signal: connectionSignal,
    });
  } finally {
    connectionController.abort(
      new DOMException("Publisher connection closed", "AbortError"),
    );
    await slot.releaseConnection(token);
  }
};
