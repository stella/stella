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
  createMatterTools,
  createOrgTools,
  validateWorkspaceIds,
} from "@/api/handlers/registry/actors/chat-tools";
import { validateUserActorSession } from "@/api/handlers/registry/utils";
import { CHAT_MODEL } from "@/api/lib/ai-models";
// biome-ignore lint/style/noRestrictedImports: brands actor-validated IDs
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { captureError } from "@/api/lib/posthog";

const DEFAULT_MODEL = CHAT_MODEL;
const caseLawTools = createCaseLawTools();
const MAX_TOOL_STEPS = 5;
/** User turns to keep in the sliding window. Tools are always
 *  available, so we use a larger window to accommodate
 *  tool-call + tool-result message pairs. */
const MESSAGE_WINDOW = 20;

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

// -- Shared prompt building blocks --

const CORE_RULES = [
  "You are Stella, an AI assistant for legal professionals.",
  "",
  "CRITICAL: Never guess, infer, or fabricate document " +
    "content. Always call readContent (or the appropriate " +
    "tool) to retrieve real data before answering. If a " +
    "tool call fails, report the error honestly.",
  "",
  "IDENTITY: You work on behalf of the user. When drafting " +
    "documents, emails, or letters, NEVER sign as 'Stella' " +
    "or identify yourself as the author. Always sign using " +
    "the user's registered name (provided below). The user " +
    "is the author; you are their tool.",
  "",
  "PLANNING: For complex or ambiguous tasks (drafting " +
    "documents, multi-step workflows), call askUser to " +
    "gather requirements BEFORE acting. After calling " +
    "askUser, STOP and present your analysis and " +
    "questions. Wait for the user's response, then " +
    "synthesize a plan and execute.",
  "",
  "Never expose internal IDs to the user in plain text.",
  "",
  "When citing documents, use markdown links:\n" +
    "[Document Name](#stella-entity=ENTITY_ID)\n" +
    "When citing matters:\n" +
    "[Matter Name](#stella-workspace=WORKSPACE_ID)\n" +
    "When citing court decisions:\n" +
    "[Case Number](#stella-decision=DECISION_ID)",
];

/** Assemble a system prompt from shared core + context. */
const buildPrompt = (
  contextLines: string[],
  userContext: UserContext | null,
): string =>
  [...CORE_RULES, "", ...contextLines, buildUserContextBlock(userContext)]
    .filter(Boolean)
    .join("\n");

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
      columns: { id: true, name: true, status: true, content: true },
    }),
    db
      .select({ value: count() })
      .from(entities)
      .where(eq(entities.workspaceId, workspaceId)),
  ]);

  const entityCount = entityCountRow?.value ?? 0;

  const propList = properties
    .filter((p) => p.status !== "uninitialized")
    .map((p) => {
      let line = `- ${p.name} (id: ${p.id}, type: ${p.content.type})`;
      if ("options" in p.content && Array.isArray(p.content.options)) {
        const opts = p.content.options
          .map((o: { value: string }) => o.value)
          .join(", ");
        line += ` [options: ${opts}]`;
      }
      return line;
    })
    .join("\n");

  return buildPrompt(
    [
      `Connected to matter "${workspace?.name ?? "Unknown"}".`,
      "",
      "Use the available tools (searchMatter, searchContent, " +
        "listEntities, readEntity, readContent) to retrieve " +
        "real data. Use searchCaseLaw for case law. Never " +
        "ask the user to call tools; just use them.",
      "",
      "SCOPE: By default, use matter-scoped tools for this " +
        "matter. Only use searchAcrossMatters / " +
        "readContentAcrossMatters when the user EXPLICITLY " +
        'asks to search outside (e.g. "across matters", ' +
        '"in other cases").',
      "",
      `Workspace ID: ${workspaceId} (pass as workspaceId).`,
      `The matter contains ${entityCount.toLocaleString()} entities.`,
      propList
        ? `\nAvailable metadata columns:\n${propList}\n` +
          "\nModify metadata with updateEntityFields; create " +
          "DOCX documents with createDocument. Both require " +
          "user approval."
        : "",
    ],
    userContext,
  );
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

  const entityLines =
    entityMentions && entityMentions.length > 0
      ? entityMentions
          .map(
            (e) => `- entityId: ${e.entityId} → workspaceId: ${e.workspaceId}`,
          )
          .join("\n")
      : "";

  return buildPrompt(
    [
      "The user may reference matters, contacts, templates, " +
        "or clauses. Use the available tools to explore them. " +
        "Use searchCaseLaw for case law.",
      "",
      matterLines ? `Referenced matters:\n${matterLines}` : "",
      entityLines
        ? "Entity-workspace mapping (use these when " +
          "calling tools):\n" +
          entityLines
        : "",
    ],
    userContext,
  );
};

/** Build a system prompt for global chat (no workspace). */
const buildGlobalPrompt = (userContext: UserContext | null): string =>
  buildPrompt(
    [
      "You have tools to search across all matters, look up " +
        "contacts, browse templates, read clauses, and search " +
        "case law. Use them when the user asks about their " +
        "data. Never ask the user to call tools; just use them.",
    ],
    userContext,
  );

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

      // Approval flow: the AI SDK sends the assistant message
      // (with tool-approval-response parts) back through the
      // transport. Replace the last stored assistant message
      // instead of appending a new one.
      if (message.role === "assistant") {
        const lastIdx = thread.messages.length - 1;
        if (lastIdx >= 0 && thread.messages[lastIdx].role === "assistant") {
          thread.messages[lastIdx] = message;
        } else {
          thread.messages.push(message);
        }
      } else {
        thread.messages.push(message);
      }

      const stopController = new AbortController();
      c.vars.stopControllers.set(threadId, stopController);
      const runSignal = joinSignals(c.abortSignal, stopController.signal);

      const allMessages = [...thread.messages];
      const messages = allMessages.slice(-MESSAGE_WINDOW);

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
      // UserActorConnState which types organizationId and userId,
      // but RivetKit erases the type on c.conn.state.
      const connState = c.conn.state as {
        organizationId: SafeId<"organization">;
        userId: string;
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

          // Build the set of workspace IDs the AI can access:
          // bound workspace (if any) + mentioned workspaces.
          const allWorkspaceIds: SafeId<"workspace">[] = [];
          if (validatedWsId) {
            allWorkspaceIds.push(validatedWsId);
          }
          for (const id of validatedMentionedIds) {
            if (!allWorkspaceIds.includes(id)) {
              allWorkspaceIds.push(id);
            }
          }

          // Org tools and case law are always available. Matter
          // tools are added when there are accessible workspaces.
          const orgTools = createOrgTools({ organizationId: orgId });
          const matterTools =
            allWorkspaceIds.length > 0
              ? createMatterTools({
                  allowedWorkspaceIds: allWorkspaceIds,
                  organizationId: orgId,
                  userId: connState.userId,
                })
              : {};
          const tools: ToolSet = {
            ...orgTools,
            ...caseLawTools,
            ...matterTools,
          };

          // System prompt: single-workspace gets a focused prompt,
          // multi-workspace or global gets the multi-context prompt.
          let system: string | undefined;
          if (validatedWsId && allWorkspaceIds.length === 1) {
            system = await buildSystemPrompt(validatedWsId, orgId, ctx);
          } else if (allWorkspaceIds.length > 0) {
            system = await buildMultiContextPrompt(
              allWorkspaceIds,
              orgId,
              ctx,
              entityWsMap,
            );
          } else {
            system = buildGlobalPrompt(ctx);
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
          const priorMessages = allMessages.slice(0, -MESSAGE_WINDOW);

          const uiStream = stream.toUIMessageStream({
            generateMessageId: nanoid,
            originalMessages: messages,
            onFinish: ({ messages: finishedMessages }) => {
              // Merge: prior messages + windowed conversation
              // (which now includes the assistant response).
              thread.messages = [...priorMessages, ...finishedMessages];
              cleanupStream();
            },
            onError: (err) => {
              captureError(err);
              return "error";
            },
          });

          // Inject source-document UI parts so the frontend can
          // render clickable source chips. pipeThrough returns
          // ReadableStream (no AsyncIterable in TS stdlib), so
          // use the reader API.
          const outputStream: ReadableStream<UIMessageChunk> =
            uiStream.pipeThrough(
              createSourceInjectionTransform(validatedWsId, orgId),
            );

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
      const connState = c.conn.state as {
        organizationId: SafeId<"organization">;
      };
      if (rawWsId) {
        return {
          prompt: await buildSystemPrompt(
            toSafeId<"workspace">(rawWsId),
            connState.organizationId,
            ctx,
          ),
        };
      }
      return { prompt: buildGlobalPrompt(ctx) };
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
