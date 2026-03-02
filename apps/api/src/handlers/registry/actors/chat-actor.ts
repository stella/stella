import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  convertToModelMessages,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { nanoid } from "nanoid";
import {
  actor,
  event,
  type ActionContextOf,
  type AnyActorDefinition,
} from "rivetkit";
import { joinSignals } from "rivetkit/utils";

import type {
  SequencedChunk as BaseSequencedChunk,
  ThreadSummary,
} from "@stella/rivet/actors/chat-actor-config";

import { env } from "@/api/env";
import { validateUserActorSession } from "@/api/handlers/registry/utils";

const model = createOpenRouter({
  apiKey: env.OPENROUTER_API_KEY,
})("google/gemini-2.5-flash");

type SequencedChunk = BaseSequencedChunk<UIMessageChunk>;

type ThreadMetadata = {
  title: string;
  createdAt: number;
};

type ThreadState = {
  running: boolean;
  messages: UIMessage[];
  pendingChunks: SequencedChunk[];
  metadata: ThreadMetadata;
};

const TITLE_MAX_LENGTH = 80;

const extractTitle = (message: UIMessage): string => {
  const raw = message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();

  if (raw.length > TITLE_MAX_LENGTH) {
    return `${raw.slice(0, TITLE_MAX_LENGTH)}…`;
  }

  return raw || "New chat";
};

const getOrCreateThread = (
  threads: Map<string, ThreadState>,
  threadId: string,
  firstMessage: UIMessage,
): ThreadState => {
  const existing = threads.get(threadId);
  if (existing) {
    return existing;
  }

  const thread: ThreadState = {
    running: false,
    messages: [],
    pendingChunks: [],
    metadata: {
      title: extractTitle(firstMessage),
      createdAt: Date.now(),
    },
  };
  threads.set(threadId, thread);
  return thread;
};

/** Run `fn` in the background via `c.waitUntil`. Errors
 *  are caught and logged instead of crashing the actor. */
const backgroundTask = (
  c: ActionContextOf<AnyActorDefinition>,
  fn: () => Promise<void>,
) => {
  c.waitUntil(
    fn().catch((error: unknown) => {
      c.log.error({ error }, "Background task failed");
    }),
  );
};

export const chatActor = actor({
  state: {
    threads: new Map<string, ThreadState>(),
  },
  events: {
    "thread-created": event<ThreadSummary>(),
    "thread-deleted": event<{ threadId: string }>(),
    "stream-started": event<{ threadId: string; chatId: string }>(),
    "stream-chunk": event<SequencedChunk>(),
  },
  createConnState: (c, params) => validateUserActorSession(c.key, params),
  vars: {
    stopControllers: new Map<string, AbortController>(),
  },
  actions: {
    sendMessages: (
      c,
      input: { threadId: string; chatId: string; message: UIMessage },
    ) => {
      const { threadId, chatId, message } = input;
      const isNew = !c.state.threads.has(threadId);
      const thread = getOrCreateThread(c.state.threads, threadId, message);

      if (thread.running) {
        return { status: "busy" as const };
      }

      thread.running = true;
      thread.pendingChunks = [];
      thread.messages.push(message);

      const stopController = new AbortController();
      c.vars.stopControllers.set(threadId, stopController);
      const runSignal = joinSignals(c.abortSignal, stopController.signal);

      const messages = [...thread.messages];

      if (isNew) {
        c.broadcast("thread-created", {
          id: threadId,
          title: thread.metadata.title,
          createdAt: thread.metadata.createdAt,
        } satisfies ThreadSummary);
      }

      c.broadcast("stream-started", { threadId, chatId });

      const cleanupStream = () => {
        thread.running = false;
        thread.pendingChunks = [];
        c.vars.stopControllers.delete(threadId);
      };

      runSignal.addEventListener("abort", () => cleanupStream(), {
        once: true,
      });

      backgroundTask(c, async () => {
        const stream = streamText({
          model,
          messages: await convertToModelMessages(messages),
          abortSignal: runSignal,
        });

        let seq = 0;
        for await (const chunk of stream.toUIMessageStream({
          generateMessageId: nanoid,
          originalMessages: messages,
          onFinish: ({ messages: finishedMessages }) => {
            thread.messages = finishedMessages;
            cleanupStream();
          },
          onError: () => "error",
        })) {
          const indexed: SequencedChunk = { threadId, seq, chunk };
          seq++;
          thread.pendingChunks.push(indexed);
          c.broadcast("stream-chunk", indexed);
        }
      });

      return { status: "started" as const };
    },
    stop: (c, input: { threadId: string }) => {
      const controller = c.vars.stopControllers.get(input.threadId);
      if (controller) {
        controller.abort();
        c.vars.stopControllers.delete(input.threadId);
      }
    },
    getMessages: (c, input: { threadId: string }) => {
      return c.state.threads.get(input.threadId)?.messages ?? [];
    },
    getStreamSnapshot: (
      c,
      input: { threadId: string; startFromSeq: number },
    ) => {
      const thread = c.state.threads.get(input.threadId);
      return {
        done: !thread?.running,
        snapshot: thread?.pendingChunks.slice(input.startFromSeq) ?? [],
      };
    },
    deleteThread: (c, input: { threadId: string }) => {
      c.vars.stopControllers.get(input.threadId)?.abort();
      c.vars.stopControllers.delete(input.threadId);
      const deleted = c.state.threads.delete(input.threadId);

      c.broadcast("thread-deleted", { threadId: input.threadId });

      return { deleted };
    },
    getThreads: (c): ThreadSummary[] => {
      const summaries: ThreadSummary[] = [];
      for (const [id, thread] of c.state.threads) {
        summaries.push({
          id,
          title: thread.metadata.title,
          createdAt: thread.metadata.createdAt,
        });
      }
      summaries.sort((a, b) => b.createdAt - a.createdAt);
      return summaries;
    },
  },
});
