import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { count, eq } from "drizzle-orm";
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
  UserContext,
} from "@stella/rivet/actors/chat-actor-config";

import { db } from "@/api/db";
import { entities } from "@/api/db/schema";
import { env } from "@/api/env";
import { createSourceInjectionTransform } from "@/api/handlers/registry/actors/chat-source-transform";
import { createMatterTools } from "@/api/handlers/registry/actors/chat-tools";
import { validateUserActorSession } from "@/api/handlers/registry/utils";
import type { SafeId } from "@/api/lib/branded-types";

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const MAX_TOOL_STEPS = 5;
/** User turns to keep in the sliding window. Tool-enabled
 *  threads need a larger window because each agentic step
 *  produces multiple intermediate messages (tool-call +
 *  tool-result pairs). */
const MESSAGE_WINDOW = 4;
const MESSAGE_WINDOW_TOOLS = 20;

const openrouter = createOpenRouter({
  apiKey: env.OPENROUTER_API_KEY,
});

const getModel = (modelId?: string) => {
  if (env.isDev && modelId) {
    return openrouter(modelId);
  }
  return openrouter(DEFAULT_MODEL);
};

type SequencedChunk = BaseSequencedChunk<UIMessageChunk>;

type ThreadMetadata = {
  title: string;
  createdAt: number;
  workspaceId: string | null;
  userContext: UserContext | null;
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
      workspaceId: null,
      userContext: null,
    },
  };
  threads.set(threadId, thread);
  return thread;
};

/** Format the current date/time in the user's timezone. */
const formatCurrentTime = (timezone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
};

/** Build user context lines for the system prompt. */
const buildUserContextBlock = (userContext: UserContext | null): string => {
  if (!userContext) {
    return "";
  }
  const lines = [`User: ${userContext.userName}`];
  if (userContext.locale) {
    lines.push(`User language: ${userContext.locale}`);
  }
  if (userContext.timezone) {
    lines.push(
      `Current date/time: ${formatCurrentTime(userContext.timezone)} (${userContext.timezone})`,
    );
  }
  return lines.join("\n");
};

/** Build a system prompt for a workspace-bound thread. */
const buildSystemPrompt = async (
  workspaceId: string,
  organizationId: string,
  userContext: UserContext | null,
): Promise<string> => {
  const [workspace, properties, [entityCountRow]] = await Promise.all([
    db.query.workspaces.findFirst({
      where: { id: workspaceId, organizationId },
      columns: { id: true, name: true },
    }),
    db.query.properties.findMany({
      where: { workspaceId },
      columns: { name: true, status: true },
    }),
    db
      .select({ value: count() })
      .from(entities)
      .where(eq(entities.workspaceId, workspaceId)),
  ]);

  const entityCount = entityCountRow?.value ?? 0;

  const propList = properties
    .filter((p) => p.status !== "uninitialized")
    .map((p) => `- ${p.name}`)
    .join("\n");

  return [
    "You are Stella, an AI assistant for legal professionals.",
    `You are connected to the matter "${workspace?.name ?? "Unknown"}".`,
    "",
    "IMPORTANT: When the user asks about the matter, its " +
      "contents, documents, or files, you MUST call the " +
      "available tools (listEntities, searchMatter, " +
      "readEntity, readContent) to retrieve real data " +
      "before answering. Never ask the user to call tools " +
      "themselves. Never describe tools to the user. " +
      "Just use them directly.",
    "",
    "Never expose internal IDs to the user in plain text; " +
      "they are meaningless to humans.",
    "",
    "When citing a specific document or file, always use a " +
      "markdown link with this exact format:\n" +
      "[Document Name](#stella-entity=ENTITY_ID)\n" +
      "The system renders this as a clickable reference. " +
      "Every document mention in your response MUST use " +
      "this link syntax.",
    "",
    `The matter contains ${entityCount.toLocaleString()} entities.`,
    propList ? `\nAvailable metadata columns:\n${propList}` : "",
    buildUserContextBlock(userContext),
  ]
    .filter(Boolean)
    .join("\n");
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
      input: {
        threadId: string;
        chatId: string;
        message: UIMessage;
        workspaceId?: string;
        modelId?: string;
        userContext?: UserContext;
      },
    ) => {
      const { threadId, chatId, message, workspaceId, modelId, userContext } =
        input;
      const isNew = !c.state.threads.has(threadId);
      const thread = getOrCreateThread(c.state.threads, threadId, message);

      if (thread.running) {
        return { status: "busy" as const };
      }

      if (isNew) {
        if (workspaceId) {
          thread.metadata.workspaceId = workspaceId;
        }
        if (userContext) {
          thread.metadata.userContext = userContext;
        }
      }

      thread.running = true;
      thread.pendingChunks = [];
      thread.messages.push(message);

      const stopController = new AbortController();
      c.vars.stopControllers.set(threadId, stopController);
      const runSignal = joinSignals(c.abortSignal, stopController.signal);

      // Sliding window: send only the last N messages to keep
      // token usage predictable. Tool-enabled threads get a
      // larger window because agentic steps expand messages.
      const windowSize = thread.metadata.workspaceId
        ? MESSAGE_WINDOW_TOOLS
        : MESSAGE_WINDOW;
      const allMessages = [...thread.messages];
      const messages = allMessages.slice(-windowSize);

      if (isNew) {
        c.broadcast("thread-created", {
          id: threadId,
          title: thread.metadata.title,
          createdAt: thread.metadata.createdAt,
          workspaceId: thread.metadata.workspaceId,
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

      // SAFETY: createConnState (validateUserActorSession) returns
      // UserActorConnState which types organizationId as SafeId,
      // but RivetKit erases the type on c.conn.state.
      const connState = c.conn.state as {
        organizationId: SafeId<"organization">;
      };
      const orgId = connState.organizationId;

      backgroundTask(c, async () => {
        try {
          const wsId = thread.metadata.workspaceId;
          const ctx = thread.metadata.userContext;

          // Validate workspace belongs to this organization
          // before granting tool access. If the workspace is
          // not found (wrong org or deleted), treat as a
          // non-workspace thread.
          let validatedWsId: string | null = null;
          if (wsId) {
            const ws = await db.query.workspaces.findFirst({
              where: { id: wsId, organizationId: orgId },
              columns: { id: true },
            });
            validatedWsId = ws ? wsId : null;
          }

          const tools = validatedWsId
            ? createMatterTools({
                workspaceId: validatedWsId,
                organizationId: orgId,
              })
            : undefined;

          const system = validatedWsId
            ? await buildSystemPrompt(validatedWsId, orgId, ctx)
            : buildUserContextBlock(ctx) || undefined;

          const stream = streamText({
            model: getModel(modelId),
            system,
            tools,
            stopWhen: validatedWsId
              ? stepCountIs(MAX_TOOL_STEPS)
              : stepCountIs(1),
            messages: await convertToModelMessages(messages),
            abortSignal: runSignal,
          });

          // Messages before the window — preserved in thread
          // state but not sent to the model.
          const priorMessages = allMessages.slice(0, -windowSize);

          const uiStream = stream.toUIMessageStream({
            generateMessageId: nanoid,
            originalMessages: messages,
            onFinish: ({ messages: finishedMessages }) => {
              // Merge: prior messages + windowed conversation
              // (which now includes the assistant response).
              thread.messages = [...priorMessages, ...finishedMessages];
              cleanupStream();
            },
            onError: () => "error",
          });

          // Inject source-document UI parts for workspace-bound
          // threads so the frontend can render clickable chips.
          // pipeThrough returns ReadableStream (no AsyncIterable
          // in TS stdlib), so use the reader API for both paths.
          const outputStream: ReadableStream<UIMessageChunk> = validatedWsId
            ? uiStream.pipeThrough(
                createSourceInjectionTransform(validatedWsId),
              )
            : uiStream;

          const reader = outputStream.getReader();
          let seq = 0;
          let done = false;
          try {
            while (!done) {
              const result = await reader.read();
              done = result.done;
              if (result.value) {
                const indexed: SequencedChunk = {
                  threadId,
                  seq,
                  chunk: result.value,
                };
                seq++;
                thread.pendingChunks.push(indexed);
                c.broadcast("stream-chunk", indexed);
              }
            }
          } finally {
            reader.releaseLock();
          }
        } finally {
          cleanupStream();
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
    getThreadsByWorkspace: (
      c,
      input: { workspaceId: string },
    ): ThreadSummary[] => {
      const summaries: ThreadSummary[] = [];
      for (const [id, thread] of c.state.threads) {
        if (thread.metadata.workspaceId !== input.workspaceId) {
          continue;
        }
        summaries.push({
          id,
          title: thread.metadata.title,
          createdAt: thread.metadata.createdAt,
          workspaceId: thread.metadata.workspaceId,
        });
      }
      summaries.sort((a, b) => b.createdAt - a.createdAt);
      return summaries;
    },
    getSystemPrompt: async (c, input: { threadId: string }) => {
      const thread = c.state.threads.get(input.threadId);
      if (!thread) {
        return { prompt: null };
      }
      const wsId = thread.metadata.workspaceId;
      const ctx = thread.metadata.userContext;
      if (!wsId) {
        return { prompt: buildUserContextBlock(ctx) || null };
      }
      const connState = c.conn.state as {
        organizationId: SafeId<"organization">;
      };
      return {
        prompt: await buildSystemPrompt(wsId, connState.organizationId, ctx),
      };
    },
    getThreads: (c): ThreadSummary[] => {
      const summaries: ThreadSummary[] = [];
      for (const [id, thread] of c.state.threads) {
        summaries.push({
          id,
          title: thread.metadata.title,
          createdAt: thread.metadata.createdAt,
          workspaceId: thread.metadata.workspaceId,
        });
      }
      summaries.sort((a, b) => b.createdAt - a.createdAt);
      return summaries;
    },
  },
});
