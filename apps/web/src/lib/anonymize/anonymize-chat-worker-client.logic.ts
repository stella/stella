import { Result } from "better-result";

import type { ChatAnonResult } from "@stll/anonymize-chat";

import { ClientOperationError } from "@/lib/errors/client";

import type {
  AnonymizeChatWorkerRequest,
  AnonymizeChatWorkerResponse,
} from "./anonymize-chat-worker-protocol";

type AnonymizeChatWorkerEventListener = ((
  type: "message",
  listener: (event: MessageEvent<AnonymizeChatWorkerResponse>) => void,
) => void) &
  ((type: "error", listener: (event: ErrorEvent) => void) => void);

type AnonymizeChatWorker = {
  addEventListener: AnonymizeChatWorkerEventListener;
  postMessage: (message: AnonymizeChatWorkerRequest) => void;
  terminate: () => void;
};

type PendingRequest = {
  resolve: (result: ChatAnonResult) => void;
  reject: (error: ClientOperationError) => void;
  timeout: ScheduledTimeout;
};

type ScheduledTimeout = { cancel: () => void };

type AnonymizeChatWorkerClientOptions = {
  createWorker: () => AnonymizeChatWorker;
  requestTimeoutMs: number;
  maxPendingRequests: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => ScheduledTimeout;
};

type AnonymizeChatRequest = Omit<
  AnonymizeChatWorkerRequest,
  "gazetteerEntries" | "id" | "locale"
>;

export const createAnonymizeChatWorkerClient = ({
  createWorker,
  requestTimeoutMs,
  maxPendingRequests,
  scheduleTimeout = (callback, delayMs) => {
    const timeout = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timeout) };
  },
}: AnonymizeChatWorkerClientOptions) => {
  let worker: AnonymizeChatWorker | null = null;
  let nextRequestId = 0;
  const pendingRequests = new Map<number, PendingRequest>();

  const takePendingRequest = (id: number): PendingRequest | undefined => {
    const pending = pendingRequests.get(id);
    pendingRequests.delete(id);
    pending?.timeout.cancel();
    return pending;
  };

  const rejectAll = (error: ClientOperationError): void => {
    for (const id of pendingRequests.keys()) {
      takePendingRequest(id)?.reject(error);
    }
  };

  const terminateActiveWorker = (
    activeWorker: AnonymizeChatWorker,
    error: ClientOperationError,
  ): void => {
    if (worker !== activeWorker) {
      return;
    }
    worker = null;
    activeWorker.terminate();
    rejectAll(error);
  };

  const ensureWorker = (): AnonymizeChatWorker => {
    if (worker !== null) {
      return worker;
    }
    const created = createWorker();
    created.addEventListener("message", ({ data }) => {
      const pending = takePendingRequest(data.id);
      if (pending === undefined) {
        return;
      }
      if (data.ok) {
        pending.resolve(data.result);
        return;
      }
      pending.reject(
        new ClientOperationError({
          action: "anonymize-chat",
          message: data.error,
        }),
      );
    });
    created.addEventListener("error", () => {
      terminateActiveWorker(
        created,
        new ClientOperationError({
          action: "anonymize-chat",
          message: "Anonymization worker crashed",
        }),
      );
    });
    worker = created;
    return created;
  };

  const anonymize = async (
    request: AnonymizeChatRequest,
  ): Promise<ChatAnonResult> => {
    if (pendingRequests.size >= maxPendingRequests) {
      return await Promise.reject(
        new ClientOperationError({
          action: "anonymize-chat",
          message: "Anonymization worker request queue is full",
        }),
      );
    }

    const workerResult = Result.try({
      try: ensureWorker,
      catch: (cause) =>
        new ClientOperationError({
          action: "anonymize-chat",
          message: `Unable to start anonymization worker: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        }),
    });
    if (Result.isError(workerResult)) {
      return await Promise.reject(workerResult.error);
    }
    const activeWorker = workerResult.value;

    nextRequestId += 1;
    const id = nextRequestId;
    return await new Promise((resolve, reject) => {
      const timeout = scheduleTimeout(() => {
        const pending = takePendingRequest(id);
        if (pending === undefined) {
          return;
        }
        const error = new ClientOperationError({
          action: "anonymize-chat",
          message: "Anonymization worker request timed out",
        });
        pending.reject(error);
        terminateActiveWorker(activeWorker, error);
      }, requestTimeoutMs);
      pendingRequests.set(id, { resolve, reject, timeout });

      const workerRequest: AnonymizeChatWorkerRequest = { id, ...request };
      const postResult = Result.try({
        try: () => {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin parameter
          activeWorker.postMessage(workerRequest);
        },
        catch: (cause) =>
          new ClientOperationError({
            action: "anonymize-chat",
            message: `Unable to send anonymization request: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            cause,
          }),
      });
      if (Result.isError(postResult)) {
        takePendingRequest(id)?.reject(postResult.error);
        terminateActiveWorker(activeWorker, postResult.error);
      }
    });
  };

  return { anonymize };
};
