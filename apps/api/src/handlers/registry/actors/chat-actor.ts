import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type ToolSet,
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
import { createCaseLawTools } from "@/api/handlers/registry/actors/chat-case-law-tools";
import {
  collectThreadMentions,
  extractEntityWorkspaceMap,
  extractWorkspaceIds,
  stripEntityWorkspacePrefixes,
} from "@/api/handlers/registry/actors/chat-mention-parser";
import { createSourceInjectionTransform } from "@/api/handlers/registry/actors/chat-source-transform";
import {
  createCrossMatterTools,
  createMatterTools,
  createMultiMatterTools,
  createOrgTools,
  validateWorkspaceIds,
} from "@/api/handlers/registry/actors/chat-tools";
import { validateUserActorSession } from "@/api/handlers/registry/utils";
// biome-ignore lint/style/noRestrictedImports: brands actor-validated IDs
import { toSafeId, type SafeId } from "@/api/lib/branded-types";

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const caseLawTools = createCaseLawTools();
const MAX_TOOL_STEPS = 5;
/** User turns to keep in the sliding window. All threads
 *  have tools (at minimum case law search), so the window
 *  must accommodate intermediate messages (tool-call +
 *  tool-result pairs). Workspace threads get a larger
 *  window due to more tool variety. */
const MESSAGE_WINDOW = 10;
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
  /** Workspace IDs mentioned across all messages. */
  mentionedWorkspaceIds: Set<string>;
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
      mentionedWorkspaceIds: new Set(),
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
  const lines = [`User registered as: ${userContext.userName}`];
  if (userContext.locale) {
    lines.push(`UX language: ${userContext.locale}`);
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
  workspaceId: SafeId<"workspace">,
  organizationId: SafeId<"organization">,
  userContext: UserContext | null,
): Promise<string> => {
  const [workspace, properties, [entityCountRow]] = await Promise.all([
    db.query.workspaces.findFirst({
      where: {
        id: { eq: workspaceId },
        organizationId: { eq: organizationId },
      },
      columns: { id: true, name: true },
    }),
    db.query.properties.findMany({
      where: { workspaceId: { eq: workspaceId } },
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
      "before answering. When the user asks about case " +
      "law, court decisions, or legal precedents, use " +
      "searchCaseLaw. Never ask the user to call tools " +
      "themselves. Never describe tools to the user. " +
      "Just use them directly.",
    "",
    "CRITICAL: You must NEVER guess, infer, or fabricate " +
      "document content based on file names, user messages, " +
      "or general knowledge. Always call readContent to read " +
      "the actual text before describing, comparing, or " +
      "summarizing any document. If a tool call fails, report " +
      "the error honestly; do not make up content.",
    "",
    "SCOPE: By default, use searchMatter, listEntities, " +
      "readEntity, and readContent to work within the " +
      "current matter. You also have " +
      "searchAcrossMatters and readContentAcrossMatters " +
      "which search across ALL matters in the " +
      "organization. Only use these cross-matter tools " +
      "when the user EXPLICITLY asks to search outside " +
      'this matter (e.g. "across matters", "in other ' +
      'cases", "across all my files"). If the user asks ' +
      "a question that could be answered from the " +
      "current matter, stay within it.",
    "",
    "Never expose internal IDs to the user in plain text; " +
      "they are meaningless to humans.",
    "",
    "When citing a specific document or file, always use a " +
      "markdown link with this exact format:\n" +
      "[Document Name](#stella-entity=ENTITY_ID)\n" +
      "When citing a court decision, use:\n" +
      "[Case Number](#stella-decision=DECISION_ID)\n" +
      "The system renders these as clickable references. " +
      "Every document or decision mention MUST use " +
      "the appropriate link syntax.",
    "",
    `The matter contains ${entityCount.toLocaleString()} entities.`,
    propList ? `\nAvailable metadata columns:\n${propList}` : "",
    buildUserContextBlock(userContext),
  ]
    .filter(Boolean)
    .join("\n");
};

/** Build a system prompt for multi-workspace or global threads. */
const buildMultiContextPrompt = async (
  mentionedWsIds: SafeId<"workspace">[],
  organizationId: SafeId<"organization">,
  userContext: UserContext | null,
  entityMentions?: { entityId: string; workspaceId: string }[],
): Promise<string> => {
  const workspaces =
    mentionedWsIds.length > 0
      ? await db.query.workspaces.findMany({
          where: {
            id: { in: mentionedWsIds },
            organizationId: { eq: organizationId },
          },
          columns: { id: true, name: true },
        })
      : [];

  const wsMap = new Map(workspaces.map((w) => [w.id, w.name]));

  const matterLines = mentionedWsIds
    .map((id) => `- "${wsMap.get(id) ?? "Unknown"}" (ID: ${id})`)
    .join("\n");

  // Entity-workspace mapping so the model knows which
  // workspace to pass when calling tools for each entity.
  const entityLines =
    entityMentions && entityMentions.length > 0
      ? entityMentions
          .map(
            (e) => `- entityId: ${e.entityId} → workspaceId: ${e.workspaceId}`,
          )
          .join("\n")
      : "";

  return [
    "You are Stella, an AI assistant for legal professionals.",
    "",
    "The user may reference matters, contacts, templates, " +
      "or clauses in their messages. Use the available tools " +
      "to explore these resources when answering. When the " +
      "user asks about case law, court decisions, or legal " +
      "precedents, use searchCaseLaw.",
    "",
    "CRITICAL: You must NEVER guess, infer, or fabricate " +
      "document content based on file names, user messages, " +
      "or general knowledge. Always call readContent to read " +
      "the actual text before describing, comparing, or " +
      "summarizing any document. If a tool call fails, report " +
      "the error honestly; do not make up content.",
    "",
    "Never expose internal IDs to the user in plain text.",
    "",
    "When citing documents, use markdown links:\n" +
      "[Document Name](#stella-entity=ENTITY_ID)\n" +
      "When citing matters, use:\n" +
      "[Matter Name](#stella-workspace=WORKSPACE_ID)\n" +
      "When citing court decisions, use:\n" +
      "[Case Number](#stella-decision=DECISION_ID)",
    "",
    matterLines ? `Referenced matters:\n${matterLines}` : "",
    entityLines
      ? "Entity-workspace mapping (use these when " +
        "calling tools):\n" +
        entityLines
      : "",
    buildUserContextBlock(userContext),
  ]
    .filter(Boolean)
    .join("\n");
};

/** Build a system prompt for a non-workspace thread. Case law
 *  search is available globally for all authenticated users. */
const buildGlobalSystemPrompt = (userContext: UserContext | null): string => {
  return [
    "You are Stella, an AI assistant for legal professionals.",
    "",
    "You can search the case law library for court decisions " +
      "using the searchCaseLaw tool. Use it when the user " +
      "asks about case law, court decisions, legal " +
      "precedents, or judicial rulings. Never ask the " +
      "user to call tools themselves. Just use them " +
      "directly.",
    "",
    "Never expose internal IDs to the user in plain text.",
    "",
    "When citing a court decision, use this format:\n" +
      "[Case Number](#stella-decision=DECISION_ID)\n" +
      "The system renders this as a clickable link to " +
      "the decision viewer.",
    "",
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
      const hasToolContext =
        !!thread.metadata.workspaceId ||
        thread.metadata.mentionedWorkspaceIds.size > 0;
      const windowSize = hasToolContext ? MESSAGE_WINDOW_TOOLS : MESSAGE_WINDOW;
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

          // Collect mentions from all messages in the thread
          // to accumulate context across the conversation.
          const mentions = collectThreadMentions(
            allMessages as {
              parts: { type: string; text?: string }[];
            }[],
          );
          const mentionedWsRawIds = extractWorkspaceIds(mentions);
          const entityWsMap = extractEntityWorkspaceMap(mentions);

          // Track mentioned workspace IDs across messages
          for (const id of mentionedWsRawIds) {
            thread.metadata.mentionedWorkspaceIds.add(id);
          }

          // Validate workspace belongs to this organization
          // before granting tool access. If the workspace is
          // not found (wrong org or deleted), treat as a
          // non-workspace thread.
          let validatedWsId: SafeId<"workspace"> | null = null;
          if (wsId) {
            const ws = await db.query.workspaces.findFirst({
              where: {
                id: wsId,
                organizationId: { eq: orgId },
              },
              columns: { id: true },
            });
            validatedWsId = ws ? toSafeId<"workspace">(wsId) : null;
          }

          // Validate mentioned workspace IDs from mentions
          const allMentionedWsIds = [...thread.metadata.mentionedWorkspaceIds];
          const validatedMentionedIds = await validateWorkspaceIds(
            allMentionedWsIds,
            orgId,
          );

          // Determine tool configuration based on context:
          // 1. Single workspace thread → single-workspace tools
          // 2. Workspace + mentioned others → multi-matter tools
          //    (includes the bound workspace in the allowed set)
          // 3. No workspace + mentions → multi-matter tools
          // 4. No workspace + no mentions → case law only
          const hasMentionedWorkspaces = validatedMentionedIds.length > 0;
          const hasAnyContext = !!validatedWsId || hasMentionedWorkspaces;

          let tools: ToolSet;
          let system: string | undefined;

          if (validatedWsId && !hasMentionedWorkspaces) {
            // Single workspace thread: local + cross-matter
            tools = {
              ...createMatterTools({
                workspaceId: validatedWsId,
                organizationId: orgId,
              }),
              ...createCrossMatterTools({
                organizationId: orgId,
              }),
              ...caseLawTools,
            };
            system = await buildSystemPrompt(validatedWsId, orgId, ctx);
          } else if (validatedWsId && hasMentionedWorkspaces) {
            // Workspace thread with cross-workspace mentions:
            // use only multi-matter tools to avoid name conflicts.
            // The bound workspace is included in the allowed set.
            const allIds = [
              validatedWsId,
              ...validatedMentionedIds.filter((id) => id !== validatedWsId),
            ];
            tools = {
              ...createMultiMatterTools({
                allowedWorkspaceIds: allIds,
                organizationId: orgId,
              }),
              ...createOrgTools({ organizationId: orgId }),
              ...caseLawTools,
            };
            system = await buildMultiContextPrompt(
              allIds,
              orgId,
              ctx,
              entityWsMap,
            );
          } else if (hasMentionedWorkspaces) {
            // Global thread with mentioned workspaces
            tools = {
              ...createMultiMatterTools({
                allowedWorkspaceIds: validatedMentionedIds,
                organizationId: orgId,
              }),
              ...createOrgTools({ organizationId: orgId }),
              ...caseLawTools,
            };
            system = await buildMultiContextPrompt(
              validatedMentionedIds,
              orgId,
              ctx,
              entityWsMap,
            );
          } else {
            // No workspace context: case law search only
            tools = { ...caseLawTools };
            system = buildGlobalSystemPrompt(ctx);
          }

          // Strip workspace prefixes from entity mention links
          // so the model sees clean entity IDs (not WS:ENTITY).
          const cleanMessages = messages.map((m) => ({
            ...m,
            parts: m.parts.map((p) =>
              p.type === "text" && "text" in p && p.text
                ? {
                    ...p,
                    text: stripEntityWorkspacePrefixes(p.text),
                  }
                : p,
            ),
          }));

          const stream = streamText({
            model: getModel(modelId),
            system,
            tools,
            stopWhen: stepCountIs(MAX_TOOL_STEPS),
            messages: await convertToModelMessages(cleanMessages),
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

          // Inject source-document UI parts for any thread that
          // has tool access so the frontend can render clickable
          // source chips. pipeThrough returns ReadableStream (no
          // AsyncIterable in TS stdlib), so use the reader API.
          const outputStream: ReadableStream<UIMessageChunk> = hasAnyContext
            ? uiStream.pipeThrough(
                createSourceInjectionTransform(validatedWsId, orgId),
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
      const rawWsId = thread.metadata.workspaceId;
      const ctx = thread.metadata.userContext;
      if (!rawWsId) {
        return { prompt: buildGlobalSystemPrompt(ctx) };
      }
      const connState = c.conn.state as {
        organizationId: SafeId<"organization">;
      };
      return {
        prompt: await buildSystemPrompt(
          toSafeId<"workspace">(rawWsId),
          connState.organizationId,
          ctx,
        ),
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
