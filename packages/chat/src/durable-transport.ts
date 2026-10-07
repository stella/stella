import { fetchServerSentEvents } from "@tanstack/ai-client";
import type {
  AnyClientTool,
  ChatClientPersistence,
  ChatPersistedState,
} from "@tanstack/ai-client";
import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { chatTurnResumeProbeSchema } from "@stll/api-contract/chat";
import type { ChatTurnResumeProbe } from "@stll/api-contract/chat";

export class ChatReconnectError extends TaggedError("ChatReconnectError")<{
  cause?: unknown;
  code?: "invalid-response" | "refused";
  message: string;
}> {}

export type ChatResumeProbe = ChatTurnResumeProbe;

const RECONNECT_WINDOW_MS = 180_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

type ReconnectDelayOptions = { attempt: number; jitter: number };

const reconnectDelay = ({ attempt, jitter }: ReconnectDelayOptions): number =>
  Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(attempt, 8)) *
  (0.5 + jitter * 0.5);

const waitForReconnect = async (
  delay: number,
  signal: AbortSignal | null | undefined,
): Promise<void> =>
  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });

type DurableChatTransportOptions<TTools extends readonly AnyClientTool[]> = {
  initialMessages: ChatPersistedState<TTools>["messages"];
  threadId: string;
  /** Server truth is checked on mount and before every read-only retry. */
  probe: (signal?: AbortSignal | null) => Promise<ChatResumeProbe>;
  joinUrl: () => string;
  sendUrl: string;
  fetchClient: typeof fetch;
  onReconnectChange: (reconnecting: boolean) => void;
  onTranscript: () => void;
  onError: (error: ChatReconnectError) => void;
  random?: () => number;
  now?: () => number;
  wait?: typeof waitForReconnect;
};

type TerminalChatResponseOptions = {
  runId: string;
  resume?: Extract<
    ChatTurnResumeProbe,
    { type: "transcript" }
  >["resumeSnapshot"];
  onTranscript: () => void;
  onReconnectChange: (reconnecting: boolean) => void;
};

const terminalChatResponse = ({
  runId,
  resume,
  onTranscript,
  onReconnectChange,
}: TerminalChatResponseOptions): Response => {
  onTranscript();
  onReconnectChange(false);
  return new Response(
    `data: ${JSON.stringify({ type: "RUN_FINISHED", runId, ...(resume?.pendingInterrupts === undefined ? {} : { outcome: { type: "interrupt", interrupts: resume.pendingInterrupts } }) })}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
};

type ChatResumePersistenceOptions<TTools extends readonly AnyClientTool[]> =
  Pick<
    DurableChatTransportOptions<TTools>,
    "initialMessages" | "probe" | "onReconnectChange" | "onError"
  > &
    Required<
      Pick<DurableChatTransportOptions<TTools>, "random" | "now" | "wait">
    >;

const createChatResumePersistence = <TTools extends readonly AnyClientTool[]>({
  initialMessages,
  probe,
  onReconnectChange,
  onError,
  random,
  now,
  wait,
}: ChatResumePersistenceOptions<TTools>) =>
  ({
    getItem: async (resumedThreadId) => {
      const began = now();
      let retries = 0;
      while (now() - began < RECONNECT_WINDOW_MS) {
        const result = await Result.tryPromise(async () => await probe());
        if (
          Result.isError(result) &&
          result.error.cause instanceof ChatReconnectError &&
          result.error.cause.code !== undefined
        ) {
          onReconnectChange(false);
          onError(result.error.cause);
          return undefined;
        }
        if (Result.isOk(result)) {
          switch (result.value.type) {
            case "running":
              return {
                messages: initialMessages,
                resume: {
                  resumeState: {
                    threadId: resumedThreadId,
                    runId: result.value.runId,
                  },
                },
              };
            case "transcript":
              onReconnectChange(false);
              return {
                messages: initialMessages,
                ...(result.value.resumeSnapshot === undefined
                  ? {}
                  : { resume: result.value.resumeSnapshot }),
              };
            case "preparing":
              break;
            default:
              return panic(result.value satisfies never);
          }
        }
        onReconnectChange(true);
        await wait(
          reconnectDelay({ attempt: retries, jitter: random() }),
          undefined,
        );
        retries += 1;
      }
      onReconnectChange(false);
      onError(new ChatReconnectError({ message: "Chat resume timed out." }));
      return undefined;
    },
    // The server owns both the transcript and resumability; no device cache.
    setItem: () => undefined,
    removeItem: () => undefined,
  }) satisfies ChatClientPersistence<TTools>;

/** Shared by hosts: cache no legal text or run pointer on the device. The
 * SDK's persistence contract restores its run from the authenticated server. */
export const createDurableChatTransport = <
  TTools extends readonly AnyClientTool[],
>({
  initialMessages,
  threadId,
  probe,
  joinUrl,
  sendUrl,
  fetchClient,
  onReconnectChange,
  onTranscript,
  onError,
  random = Math.random,
  now = () => performance.now(),
  wait = waitForReconnect,
}: DurableChatTransportOptions<TTools>) => {
  let reconnectStartedAt: number | undefined;
  let attempt = 0;
  const resumableFetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const isReplay = init?.method === "GET" || headers.has("Last-Event-ID");
      if (!isReplay) {
        reconnectStartedAt = undefined;
        attempt = 0;
        return await fetchClient(input, init);
      }
      const source = new URL(
        input instanceof Request ? input.url : String(input),
      );
      const runId =
        source.searchParams.get("runId") ?? headers.get("X-Run-Id") ?? "";
      onReconnectChange(true);
      reconnectStartedAt ??= now();
      while (!init?.signal?.aborted) {
        if (now() - reconnectStartedAt >= RECONNECT_WINDOW_MS) {
          throw new ChatReconnectError({
            message: "Chat reconnection timed out.",
          });
        }
        if (attempt > 0) {
          await wait(
            reconnectDelay({ attempt: attempt - 1, jitter: random() }),
            init?.signal,
          );
        }
        attempt += 1;
        const result = await Result.tryPromise(async () => {
          const state = await probe(init?.signal);
          switch (state.type) {
            case "transcript":
              return terminalChatResponse({
                runId,
                resume: state.resumeSnapshot,
                onTranscript,
                onReconnectChange,
              });
            case "preparing":
              return undefined;
            case "running":
              break;
            default:
              return panic(state satisfies never);
          }
          const target = new URL(joinUrl());
          // Translate the SDK delivery offset to the run-log cursor query.
          target.searchParams.set(
            "lastEventId",
            source.searchParams.get("offset") ?? "-1",
          );
          const response = await fetchClient(target, {
            ...init,
            method: "GET",
            body: undefined,
          });
          if (
            response.headers.get("Content-Type")?.includes("application/json")
          ) {
            // A log can close or expire between the probe and join.
            if (!response.ok) {
              throw new ChatReconnectError({
                message: `Chat rejoin failed (${response.status}).`,
              });
            }
            const body: unknown = await response.json();
            const parsed = v.safeParse(chatTurnResumeProbeSchema, body);
            if (!parsed.success || parsed.output.type !== "transcript") {
              throw new ChatReconnectError({
                code: "invalid-response",
                message: "Invalid chat rejoin response.",
              });
            }
            return terminalChatResponse({
              runId,
              resume: parsed.output.resumeSnapshot,
              onTranscript,
              onReconnectChange,
            });
          }
          if (!response.ok) {
            throw new ChatReconnectError({
              message: `Chat rejoin failed (${response.status}).`,
            });
          }
          onReconnectChange(false);
          return response;
        });
        if (Result.isOk(result) && result.value !== undefined) {
          return result.value;
        }
        if (
          Result.isError(result) &&
          result.error.cause instanceof ChatReconnectError &&
          result.error.cause.code !== undefined
        ) {
          onError(result.error.cause);
          return new Response(null, { status: 502 });
        }
        if (init?.signal?.aborted) {
          throw init?.signal.reason;
        }
      }
      throw init?.signal?.reason;
    },
    { preconnect: () => undefined },
  ) satisfies typeof fetch;

  const persistence = createChatResumePersistence({
    initialMessages,
    probe,
    onReconnectChange,
    onError,
    random,
    now,
    wait,
  });

  const upstream = fetchServerSentEvents(sendUrl, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    fetchClient: resumableFetch,
    reconnect: { delayMs: 0, maxAttempts: 100 },
  });
  const progress = () => {
    reconnectStartedAt = undefined;
    attempt = 0;
  };
  return {
    connection: {
      async *connect(...args: Parameters<typeof upstream.connect>) {
        for await (const chunk of upstream.connect(...args)) {
          progress();
          yield chunk;
        }
      },
      async *joinRun(runId: string, signal?: AbortSignal) {
        // The SDK bounds first-event attachment to two seconds. Establish the
        // known running lifecycle before a bounded network retry, without
        // changing the transcript or invoking a provider.
        yield { type: "RUN_STARTED" as const, runId, threadId };
        for await (const chunk of upstream.joinRun(runId, signal)) {
          progress();
          yield chunk;
        }
      },
    },
    persistence,
  };
};
