import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  DataTag,
  InvalidateQueryFilters,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import { panic } from "better-result";

import type { ReasoningEffort } from "@stll/ai-catalog";
import {
  DOCX_SUGGESTION_SURFACE,
  type DocxSuggestionSurface,
} from "@stll/api-contract/chat-docx-suggestions";

import type { ChatContextUsage } from "@/components/chat/chat-context-meter";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { sanitizeRunningToolCalls } from "@/components/chat/chat-ui-tools";
import type { ActiveSkillChatContext } from "@/components/inspector/inspector-active-skill";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { WebApiRoutes } from "@/lib/api";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { createChatThreadId, toChatThreadId } from "@/lib/chat-thread-ref";
import { STALE_TIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import { invalidateWorkspaceActivity } from "@/lib/workspaces/queries";

import { chatKeys, getChatRuntimeContextKind } from "./chat-query-contract";
import type {
  ChatThreadKey,
  ChatThreadOptionsContext,
  ChatThreadOptionsInput,
  ChatThreadTitleKey,
  DecisionChatThreadKey,
  FileChatThreadKey,
  GroupedChatThreadsKey,
  TemplateChatThreadKey,
} from "./chat-query-contract";
import { chatToolGrantsOptions } from "./chat-tool-grants";

const CHAT_THREADS_PAGE_SIZE = 50;

type SerializedChatMessage =
  WebApiRoutes["chat"]["threads"][":threadId"]["messages"]["get"]["response"][200]["messages"][number];

const readChatTimestamp = (value: string): Date =>
  parseDeterministicDate(value) ??
  panic("The chat API returned an invalid timestamp");

const deserializeChatPart = (
  part: SerializedChatMessage["parts"][number],
): PersistedChatMessage["parts"][number] => {
  if (part.type === "subagent") {
    return panic("A persisted chat message contains a subagent part");
  }
  if (part.type !== "tool-result") {
    return part;
  }
  const { createdAt, ...rest } = part;
  return createdAt === undefined
    ? rest
    : { ...rest, createdAt: readChatTimestamp(createdAt) };
};

const deserializeChatMessages = (
  messages: readonly SerializedChatMessage[],
): PersistedChatMessage[] =>
  messages.map(({ createdAt, parts, ...message }) => ({
    ...message,
    createdAt: readChatTimestamp(createdAt),
    parts: parts.map(deserializeChatPart),
  }));

/**
 * Where a thread's opening history came from. "parent-unavailable" is a fork
 * whose source cannot be opened any more (deleted, or a matter this user lost
 * access to); the fork still says it inherited its history.
 */
export type ForkProvenance =
  | { type: "none" }
  | { type: "parent-unavailable" }
  | {
      threadId: string;
      title: string;
      type: "parent";
      workspaceId: string | null;
    };

/**
 * The files a thread attached, beside the number the server found. Derived
 * from the history list's context, which the thread read returns by the same
 * server type, so both surfaces stay one shape.
 */
export type ChatThreadAttachedFiles = Pick<
  ChatHistoryItem["context"],
  "fileCount" | "files"
>;

const EMPTY_ATTACHED_FILES: ChatThreadAttachedFiles = {
  fileCount: 0,
  files: [],
};

type ThreadFetch = {
  activeSkill: ActiveSkillChatContext | null;
  /** The thread's turn not yet settled; null when every turn has settled. */
  activeTurnId: SafeId<"chatTurn"> | null;
  attachedFiles: ChatThreadAttachedFiles;
  /** Where this thread's opening history came from. */
  forkProvenance: ForkProvenance;
  messages: PersistedChatMessage[];
  /** Cursor for the page before the oldest loaded message; null when none. */
  olderCursor: string | null;
  contextMatterIds: string[];
  /** ISO timestamp of the most recent message, or null when empty. */
  lastActivityAt: string | null;
  /** Changes whenever the persisted thread is updated. */
  threadRevision: string | null;
  /** Whether the requested thread row exists; false only for allowed drafts. */
  threadExists: boolean;
  /** Whether any persisted turn in this thread used anonymization. */
  usedAnonymization: boolean;
  webSearchAvailable: boolean;
  webSearchEnabled: boolean;
  /** Per-thread model override ("provider::modelId"); null uses the org
   *  default (see `chatModelSelection.ts` on the API side). */
  model: string | null;
  /** Explicit effort for a manual model; null in Auto/provider-default mode. */
  reasoningEffort: ReasoningEffort | null;
  /** Model-context estimate for the next send; null for a missing or empty
   *  thread (nothing to meter yet). */
  context: ChatContextUsage | null;
};

type FetchChatMessageOptions = {
  threadId: string;
  messageId: string;
};

export const fetchChatMessage = async ({
  threadId,
  messageId,
}: FetchChatMessageOptions) => {
  const message = unwrapApiResponse(
    await api.chat.threads({ threadId }).messages({ messageId }).get(),
  );
  const { createdAt, parts, ...rest } = message;
  return {
    ...rest,
    createdAt: readChatTimestamp(createdAt),
    parts: parts.map(deserializeChatPart),
  };
};

const fetchThreadMessages = async (
  key: ChatThreadKey,
  {
    allowMissingThread = false,
  }: {
    allowMissingThread?: boolean | undefined;
  } = {},
): Promise<ThreadFetch> => {
  const response = await api.chat
    .threads({ threadId: key.threadId })
    .messages.get({
      query: {
        ...(allowMissingThread ? { allowMissingThread: true } : {}),
        ...(key.scope === "workspace"
          ? { workspaceId: toSafeId<"workspace">(key.workspaceId) }
          : {}),
      },
    });

  if (response.error && allowMissingThread && response.error.status === 404) {
    return {
      activeSkill: null,
      activeTurnId: null,
      attachedFiles: EMPTY_ATTACHED_FILES,
      forkProvenance: { type: "none" },
      messages: [],
      olderCursor: null,
      contextMatterIds: [],
      lastActivityAt: null,
      threadRevision: null,
      threadExists: false,
      usedAnonymization: false,
      webSearchAvailable: false,
      webSearchEnabled: false,
      model: null,
      reasoningEffort: null,
      context: null,
    };
  }

  const data = unwrapApiResponse(response);
  return {
    activeSkill: data.activeSkill,
    activeTurnId: data.activeTurnId,
    attachedFiles: data.attachedFiles,
    forkProvenance: data.forkProvenance,
    messages: deserializeChatMessages(data.messages),
    olderCursor: data.olderCursor,
    contextMatterIds: data.contextMatterIds,
    lastActivityAt: data.lastActivityAt,
    threadRevision: data.threadRevision,
    threadExists: data.threadExists,
    usedAnonymization: data.usedAnonymization,
    webSearchAvailable: data.webSearchAvailable,
    webSearchEnabled: data.webSearchEnabled,
    model: data.model,
    reasoningEffort: data.reasoningEffort,
    context: data.context,
  };
};

type OlderMessagesFetch = {
  messages: PersistedChatMessage[];
  olderCursor: string | null;
};

export const fetchOlderMessages = async ({
  key,
  before,
}: {
  key: ChatThreadKey;
  before: string;
}): Promise<OlderMessagesFetch> => {
  const response = await api.chat
    .threads({ threadId: key.threadId })
    .messages.older.get({
      query: {
        before,
        ...(key.scope === "workspace"
          ? { workspaceId: toSafeId<"workspace">(key.workspaceId) }
          : {}),
      },
    });

  const data = unwrapApiResponse(response);

  return {
    messages: deserializeChatMessages(data.messages),
    olderCursor: data.olderCursor,
  };
};

const fetchGroupedChatThreads = async ({
  cursor,
  search,
  signal,
  workspaceId,
}: {
  cursor?: string | undefined;
  search?: string | undefined;
  signal?: AbortSignal | undefined;
  workspaceId?: string | undefined;
} = {}) => {
  const response = await api.chat.threads.get({
    ...(signal !== undefined && { fetch: { signal } }),
    query: {
      limit: CHAT_THREADS_PAGE_SIZE,
      ...(cursor !== undefined && { cursor }),
      ...(search !== undefined && { search }),
      ...(workspaceId !== undefined && {
        workspaceId: toSafeId<"workspace">(workspaceId),
      }),
    },
  });

  return unwrapApiResponse(response);
};

type GroupedChatThreadsPage = Awaited<
  ReturnType<typeof fetchGroupedChatThreads>
>;
export type GroupedChatThreads = Pick<
  GroupedChatThreadsPage,
  "global" | "workspaces"
>;

type GlobalChatHistoryItem = GroupedChatThreads["global"][number] & {
  scope: "global";
};

type WorkspaceChatHistoryItem =
  GroupedChatThreads["workspaces"][number]["threads"][number] &
    Pick<
      GroupedChatThreads["workspaces"][number],
      "workspaceId" | "workspaceName"
    > & {
      scope: "workspace";
    };

export type ChatHistoryItem = GlobalChatHistoryItem | WorkspaceChatHistoryItem;

type FileChatThreadFetchResult = {
  /** Null when no thread exists for this file yet; the query layer then
   *  mounts a local draft and the thread is materialized on first send. */
  threadId: ChatThreadId | null;
  activeTurnId: SafeId<"chatTurn"> | null;
  /** The rest mirror `ChatThreadFetched` so the initial message page the
   *  server already loaded (see `read-file-thread.ts` /
   *  `resolve-file-thread.ts`) can seed `chatThreadOptions`' cache
   *  directly, collapsing the lookup -> GET /messages waterfall into one
   *  round trip. */
  attachedFiles: ChatThreadAttachedFiles;
  messages: PersistedChatMessage[];
  olderCursor: string | null;
  contextMatterIds: string[];
  lastActivityAt: string | null;
  threadRevision: string | null;
  threadExists: boolean;
  usedAnonymization: boolean;
  webSearchAvailable: boolean;
  webSearchEnabled: boolean;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  context: ChatContextUsage | null;
};

/** Read-only lookup a document open issues: never creates threads, mapping
 *  rows, or audit records (that write path runs once, in
 *  `materializeFileChatThread` below, when the first message is sent). */
const fetchFileChatThread = async ({
  entityId,
  fieldId,
  workspaceId,
}: FileChatThreadKey): Promise<FileChatThreadFetchResult> => {
  const response = await api.chat
    .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["file-thread"].get({
      query: {
        entityId: toSafeId<"entity">(entityId),
        fieldId: toSafeId<"field">(fieldId),
      },
    });

  const data = unwrapApiResponse(response);

  return {
    threadId: data.threadId === null ? null : toChatThreadId(data.threadId),
    activeTurnId: data.activeTurnId,
    attachedFiles: data.attachedFiles,
    messages: deserializeChatMessages(data.messages),
    olderCursor: data.olderCursor,
    contextMatterIds: data.contextMatterIds,
    lastActivityAt: data.lastActivityAt,
    threadRevision: null,
    threadExists: data.threadId !== null,
    usedAnonymization: data.usedAnonymization,
    webSearchAvailable: data.webSearchAvailable,
    webSearchEnabled: data.webSearchEnabled,
    model: data.model,
    reasoningEffort: data.reasoningEffort,
    context: data.context,
  };
};

const fetchTemplateChatThread = async ({
  templateId,
}: TemplateChatThreadKey): Promise<ChatThreadId> => {
  const response = await api.chat["template-thread"].post({
    templateId: toSafeId<"template">(templateId),
  });

  return toChatThreadId(unwrapApiResponse(response).threadId);
};

export const mergeGroupedChatThreadPages = (
  pages: readonly GroupedChatThreadsPage[] | undefined,
): GroupedChatThreads => {
  const global: GroupedChatThreads["global"] = [];
  const workspacesById = new Map<
    string,
    GroupedChatThreads["workspaces"][number]
  >();
  const seenThreadIds = new Set<string>();

  if (!pages) {
    return { global, workspaces: [] };
  }
  for (const page of pages) {
    for (const thread of page.global) {
      if (seenThreadIds.has(thread.id)) {
        continue;
      }
      seenThreadIds.add(thread.id);
      global.push(thread);
    }

    for (const workspace of page.workspaces) {
      const existing = workspacesById.get(workspace.workspaceId);
      if (!existing) {
        const threads: typeof workspace.threads = [];
        for (const thread of workspace.threads) {
          if (seenThreadIds.has(thread.id)) {
            continue;
          }
          seenThreadIds.add(thread.id);
          threads.push(thread);
        }
        workspacesById.set(workspace.workspaceId, { ...workspace, threads });
        continue;
      }

      for (const thread of workspace.threads) {
        if (seenThreadIds.has(thread.id)) {
          continue;
        }
        seenThreadIds.add(thread.id);
        existing.threads.push(thread);
      }
    }
  }

  return { global, workspaces: Array.from(workspacesById.values()) };
};

/**
 * Canonical cross-scope chat-history projection. Every history surface consumes
 * this list so global and matter chats cannot acquire separate inclusion or
 * ordering rules.
 */
export const listChatHistoryItems = (
  groupedThreads: GroupedChatThreads,
): ChatHistoryItem[] => {
  const items: ChatHistoryItem[] = groupedThreads.global.map((thread) => ({
    ...thread,
    scope: "global",
  }));

  for (const workspace of groupedThreads.workspaces) {
    for (const thread of workspace.threads) {
      items.push({
        ...thread,
        scope: "workspace",
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
      });
    }
  }

  return items.toSorted((left, right) => {
    const updatedAtDelta =
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    if (updatedAtDelta !== 0) {
      return updatedAtDelta;
    }
    if (left.id < right.id) {
      return 1;
    }
    if (left.id > right.id) {
      return -1;
    }
    return 0;
  });
};

export type ChatThreadFetched = {
  activeSkill: ActiveSkillChatContext | null;
  /**
   * The thread's turn not yet settled when this page was read, which the
   * composer's Stop cancels. Null when every turn has settled.
   */
  activeTurnId: SafeId<"chatTurn"> | null;
  /**
   * The files the thread attached, for the header's file stack. Read with
   * the page because older messages page in on demand, so the transcript
   * alone cannot list them; refreshed with the page after every turn.
   */
  attachedFiles: ChatThreadAttachedFiles;
  /**
   * Where this thread's opening history came from, driving the "forked from"
   * banner above the transcript.
   */
  forkProvenance: ForkProvenance;
  /**
   * Sanitized initial history for this thread (running tool-call
   * parts left by a stream that died mid-call are dropped — see
   * `sanitizeRunningToolCalls`). Pure server data: this
   * query never builds a `ChatRuntime` (see `chatThreadOptions`
   * docs below), so a route loader can prefetch it safely. Callers
   * that need a live runtime pass this array as `initialMessages`
   * to `acquireChatRuntime` / `useChatThreadRuntime`.
   */
  messages: PersistedChatMessage[];
  /**
   * Cursor for the page of messages immediately older than the
   * oldest message in `messages`. Null when the thread's full
   * history is already loaded. Consumers seed local load-older
   * state from this and replace it with each older-page response's
   * cursor.
   */
  olderCursor: string | null;
  /**
   * Persisted contextMatterIds for this thread, fresh from the
   * server. Consumers feed this into local picker state on mount;
   * subsequent changes flow back through `getContextMatterIds` on
   * the transport, not through this read.
   */
  contextMatterIds: string[];
  /**
   * ISO timestamp of the most recent persisted message (null for an
   * empty thread). Drives the revisit-recap staleness check.
   */
  lastActivityAt: string | null;
  /** Server revision for in-place transcript changes; null for drafts and
   *  file-thread bootstrap seeds. */
  threadRevision: string | null;
  /** False only when an allow-missing query resolved an unpersisted draft. */
  threadExists: boolean;
  /** True once any persisted turn in this thread used anonymization. */
  usedAnonymization: boolean;
  webSearchAvailable: boolean;
  /**
   * Per-thread web-search opt-in. Mutated via PATCH /chat/threads/:id
   * with optimistic cache update; the next send-message reads the
   * persisted value to decide whether to expose the web_search +
   * fetch_url tools to the model.
   */
  webSearchEnabled: boolean;
  /** Per-thread model override ("provider::modelId"); null uses the org
   *  default. Mutated via PATCH /chat/threads/:id/model, same shape as
   *  `webSearchEnabled` above. */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /**
   * Model-context estimate for the next send, driving the composer
   * meter. Null for a missing or empty thread (nothing to meter yet).
   */
  context: ChatContextUsage | null;
};

type FileChatThreadOptionsArgs = {
  activeOrganizationId: string;
  key: FileChatThreadKey;
  /**
   * Whether the overlay wires a live Folio editor ref for this file (the
   * DOCX browser-edit surface). This is the same condition
   * `FileChatOverlayInner` uses to decide whether its own
   * `chatThreadContext` carries `getDocxSuggestionSurface` or
   * `getActiveFile` — which in turn decides the `contextKind` baked into
   * `chatThreadOptions`' cache key (see `getChatRuntimeContextKind`).
   * Passed through so the seed below lands under the exact key that
   * overlay's `useSuspenseQuery(chatThreadOptions(...))` will look up.
   */
  hasDocxEditSurface: boolean;
};

/** Never actually invoked: exists only so its presence steers
 *  `getChatRuntimeContextKind` to "active-docx-edit", matching the real
 *  `chatThreadContext` the docx-editing overlay builds once mounted. */
const stubGetDocxSuggestionSurface = (): DocxSuggestionSurface =>
  DOCX_SUGGESTION_SURFACE.fileOverlay;

/** Never actually invoked: mirrors `getActiveFile`'s presence for the
 *  non-docx (PDF) overlay, steering `getChatRuntimeContextKind` to
 *  "active-file" the same way the real overlay's context does. */
const stubGetActiveFile = (): undefined => undefined;

/** The thread identity `fileChatThreadOptions` resolves. `threadExists`
 *  false means `threadId` is a local draft id: the overlay must call
 *  `materializeFileChatThread` before its first send persists anything. */
export type FileChatThreadBinding = {
  threadId: ChatThreadId;
  threadExists: boolean;
};

/** Seed `chatThreadOptions`' pure-data cache with a message page the
 *  file-thread lookup already loaded server-side, so the overlay's own
 *  useSuspenseQuery(chatThreadOptions(...)) right after resolves from cache
 *  instead of firing a second GET /messages. */
const seedFileThreadMessageCache = ({
  activeOrganizationId,
  client,
  fetched,
  hasDocxEditSurface,
  threadId,
  workspaceId,
}: {
  activeOrganizationId: string;
  client: QueryClient;
  fetched: Omit<FileChatThreadFetchResult, "threadId">;
  hasDocxEditSurface: boolean;
  threadId: ChatThreadId;
  workspaceId: string;
}): void => {
  const threadRef: ChatThreadRef = {
    scope: "workspace",
    threadId,
    workspaceId,
  };
  const stubContext: ChatThreadOptionsContext = hasDocxEditSurface
    ? {
        allowMissingThread: true,
        getDocxSuggestionSurface: stubGetDocxSuggestionSurface,
      }
    : { allowMissingThread: true, getActiveFile: stubGetActiveFile };

  client.setQueryData(
    chatThreadOptions({
      activeOrganizationId,
      key: threadRef,
      context: stubContext,
    }).queryKey,
    {
      // A file thread is opened from its document, never forked: the fork
      // action is only offered on the main chat surface.
      forkProvenance: { type: "none" } as const,
      activeTurnId: fetched.activeTurnId,
      attachedFiles: fetched.attachedFiles,
      messages: sanitizeRunningToolCalls(fetched.messages),
      olderCursor: fetched.olderCursor,
      activeSkill: null,
      contextMatterIds: fetched.contextMatterIds,
      lastActivityAt: fetched.lastActivityAt,
      threadRevision: fetched.threadRevision,
      threadExists: fetched.threadExists,
      usedAnonymization: fetched.usedAnonymization,
      webSearchAvailable: fetched.webSearchAvailable,
      webSearchEnabled: fetched.webSearchEnabled,
      model: fetched.model,
      reasoningEffort: fetched.reasoningEffort,
      context: fetched.context,
    },
  );
};

export const fileChatThreadOptions = ({
  activeOrganizationId,
  key,
  hasDocxEditSurface,
}: FileChatThreadOptionsArgs) =>
  // oxlint-disable-next-line @tanstack/query/exhaustive-deps -- `hasDocxEditSurface` deliberately excluded from this query's key: the file-thread identity it resolves is the same regardless of docx-vs-pdf, it only steers which sibling `chatThreadOptions` cache key the queryFn seeds below.
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.fileThread(activeOrganizationId, key),
    queryFn: async ({ client }): Promise<FileChatThreadBinding> => {
      const fetched = await fetchFileChatThread(key);

      // No thread yet: mount the overlay on a local draft id (same pattern
      // as a fresh /chat/new thread). Nothing is persisted until the first
      // send calls `materializeFileChatThread` with this same id. A refetch
      // must reuse the draft id already bound for this key: the composer
      // keys its unsent draft on the thread id, so minting a fresh one here
      // would remount the overlay and orphan typed-but-unsent text.
      const previous = client.getQueryData(
        fileChatThreadOptions({ activeOrganizationId, key, hasDocxEditSurface })
          .queryKey,
      );
      const threadId =
        fetched.threadId ??
        (previous !== undefined && !previous.threadExists
          ? previous.threadId
          : createChatThreadId());

      seedFileThreadMessageCache({
        activeOrganizationId,
        client,
        fetched,
        hasDocxEditSurface,
        threadId,
        workspaceId: key.workspaceId,
      });

      // The tool grants of this thread load with the binding, not after the
      // overlay mounts: a draft thread has none, and a persisted one starts
      // its read as soon as its id is known.
      const grantsOptions = chatToolGrantsOptions({
        activeOrganizationId,
        threadId,
        userId: key.userId,
      });
      if (fetched.threadId === null) {
        client.setQueryData(grantsOptions.queryKey, { grants: [] });
      } else {
        detached(
          client.query(grantsOptions),
          "chat-queries.prefetch-file-thread-tool-grants",
        );
      }

      return { threadId, threadExists: fetched.threadId !== null };
    },
  });

type MaterializeFileChatThreadArgs = {
  activeOrganizationId: string;
  client: QueryClient;
  /** The draft id the overlay is mounted on; the server persists the thread
   *  under this exact id in the common case, so the runtime never rebinds. */
  draftThreadId: ChatThreadId;
  hasDocxEditSurface: boolean;
  key: FileChatThreadKey;
};

/**
 * Persist the file's chat thread (thread row + file mapping, audited) via
 * the materializing POST. Runs once, from the overlay's first send; a
 * repeat call is a server-side get-or-create and converges on the same
 * thread. Returns the persisted binding, which normally carries
 * `draftThreadId` itself; a different id means another session materialized
 * the same file's thread first, and the caches are updated to rebind the
 * overlay to it.
 */
export const materializeFileChatThread = async ({
  activeOrganizationId,
  client,
  draftThreadId,
  hasDocxEditSurface,
  key,
}: MaterializeFileChatThreadArgs): Promise<FileChatThreadBinding> => {
  const response = await api.chat
    .workspaces({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
    ["file-thread"].post({
      entityId: toSafeId<"entity">(key.entityId),
      fieldId: toSafeId<"field">(key.fieldId),
      threadId: toSafeId<"chatThread">(draftThreadId),
    });

  const data = unwrapApiResponse(response);
  const threadId = toChatThreadId(data.threadId);
  const binding: FileChatThreadBinding = { threadId, threadExists: true };

  client.setQueryData(
    fileChatThreadOptions({ activeOrganizationId, key, hasDocxEditSurface })
      .queryKey,
    binding,
  );
  if (threadId !== draftThreadId) {
    // Rebinding to a concurrently-created thread: seed its real message
    // page so the overlay remounts with that thread's history.
    seedFileThreadMessageCache({
      activeOrganizationId,
      client,
      fetched: {
        activeTurnId: data.activeTurnId,
        attachedFiles: data.attachedFiles,
        messages: deserializeChatMessages(data.messages),
        olderCursor: data.olderCursor,
        contextMatterIds: data.contextMatterIds,
        lastActivityAt: data.lastActivityAt,
        threadRevision: null,
        threadExists: true,
        usedAnonymization: data.usedAnonymization,
        webSearchAvailable: data.webSearchAvailable,
        webSearchEnabled: data.webSearchEnabled,
        model: data.model,
        reasoningEffort: data.reasoningEffort,
        context: data.context,
      },
      hasDocxEditSurface,
      threadId,
      workspaceId: key.workspaceId,
    });
  }

  return binding;
};

type TemplateChatThreadOptionsArgs = {
  activeOrganizationId: string;
  key: TemplateChatThreadKey;
};

export const templateChatThreadOptions = ({
  activeOrganizationId,
  key,
}: TemplateChatThreadOptionsArgs) =>
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.templateThread(activeOrganizationId, key),
    queryFn: async () => await fetchTemplateChatThread(key),
  });

/**
 * The reader's own conversation about a decision, found on the server by
 * the decision it is about; null until the reader has sent a first message.
 */
export const decisionChatThreadOptions = ({
  activeOrganizationId,
  key,
}: {
  activeOrganizationId: string;
  key: DecisionChatThreadKey;
}) =>
  queryOptions({
    queryKey: chatKeys.decisionThread(activeOrganizationId, key),
    queryFn: async ({ signal }) => {
      const response = await api.chat["decision-threads"]({
        decisionId: key.decisionId,
      }).get({ fetch: { signal } });
      const { threadId } = unwrapApiResponse(response);
      return { threadId: threadId === null ? null : toChatThreadId(threadId) };
    },
  });

export type ChatThreadOptionsArgs = ChatThreadOptionsInput & {
  activeOrganizationId: string;
};

/**
 * Cache-identity key shared by `chatThreadOptions`' `queryKey` and the
 * runtime registry. Keeping both derivations behind this one
 * helper guarantees a query cache entry and its registered `ChatRuntime`
 * are always addressed by the exact same (org, thread, allowMissingThread,
 * contextKind) tuple — they can drift in content, never in identity.
 */
export const chatThreadCacheKey = ({
  activeOrganizationId,
  context,
  key,
}: {
  activeOrganizationId: string;
  context: ChatThreadOptionsContext | undefined;
  key: ChatThreadKey;
}) =>
  chatKeys.thread(activeOrganizationId, {
    ...key,
    allowMissingThread: context?.allowMissingThread,
    contextKind: getChatRuntimeContextKind(context),
  });

// Every context capability (getter/handler) that changes what a runtime
// SENDS. `allowMissingThread` is excluded: it shapes the fetch, not the
// send, and is already part of the query key.
type ChatContextQueryOnlyKey = "allowMissingThread";
type ChatContextCapabilityKey = Exclude<
  keyof ChatThreadOptionsContext,
  ChatContextQueryOnlyKey
>;

/**
 * Deterministic encoding of WHICH capabilities a context carries (fixed
 * declaration order, presence only). Registry identity is deliberately
 * STRICTER than cache identity: the pure-data query is context-free, so
 * distinct surfaces may share one cache entry (and the query key must
 * stay stable for invalidation targeting), but a runtime's send path
 * uses exactly the getters present at build time. `contextKind` in the
 * query key only records the FIRST matched kind and ignores getters like
 * `getActiveDecision` entirely, so two surfaces with different
 * capability sets can share a query key; without this fingerprint an
 * idle runtime built by the capability-poorer surface could be reused
 * seed-equal by the richer one, and its sends would silently omit that
 * context.
 */
export const chatContextCapabilityFingerprint = (
  context: ChatThreadOptionsContext | undefined,
): string => {
  const capabilities = {
    getActiveDecision: context?.getActiveDecision,
    getActiveDraft: context?.getActiveDraft,
    getActiveExternal: context?.getActiveExternal,
    getActiveFile: context?.getActiveFile,
    getActiveSkill: context?.getActiveSkill,
    getActiveStatute: context?.getActiveStatute,
    getActiveTemplate: context?.getActiveTemplate,
    getContextMatterIds: context?.getContextMatterIds,
    getDocxEditRepresentation: context?.getDocxEditRepresentation,
    getEditApplyMode: context?.getEditApplyMode,
    getSendMode: context?.getSendMode,
    getUserContext: context?.getUserContext,
    getDocxSuggestionSurface: context?.getDocxSuggestionSurface,
  } satisfies {
    [Key in ChatContextCapabilityKey]-?: ChatThreadOptionsContext[Key];
  };
  return Object.entries(capabilities)
    .filter(([, getter]) => getter !== undefined)
    .map(([name]) => name)
    .join(",");
};

export const chatThreadOptions = ({
  activeOrganizationId,
  key,
  context,
}: ChatThreadOptionsArgs) =>
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    // This query fetches PURE thread data — messages, cursor, matter ids,
    // web-search flags, context estimate — and nothing else. It never
    // builds a `ChatRuntime`, on purpose: a route loader can call
    // `ensureRouteQueryData(chatThreadOptions(...))` before any chat
    // component has mounted, with no live `getUserContext` /
    // `getContextMatterIds` / `getSendMode` getters available yet. If
    // queryFn built the runtime here, a loader-triggered fetch would bake
    // in a stub context for the runtime's entire lifetime (until the next
    // invalidation) — including the first `sendMode` resolution, which
    // would silently fall back to `CHAT_SEND_MODE.rawOverride` and drop
    // the user's anonymization choice. See `acquireChatRuntime` /
    // `useChatThreadRuntime`: the runtime is always built at the point a
    // component (or the `/chat` route-handoff sender) actually holds live
    // getters, never here.
    //
    // `structuralSharing: false` is kept even though this query's data no
    // longer embeds a `ChatRuntime` (the historical reason it was added —
    // see the "chat runtime identity across query refetch" tests). Every
    // refetch of this query still means "the server's authoritative
    // messages changed"; handing back a fresh object each time (instead of
    // walking it for structural equality) keeps that signal simple and
    // costs nothing since nothing here is expensive to diff.
    structuralSharing: false,
    queryKey: chatThreadCacheKey({ activeOrganizationId, context, key }),
    queryFn: async (): Promise<ChatThreadFetched> => {
      const fetched = await fetchThreadMessages(key, {
        allowMissingThread: context.allowMissingThread,
      });

      return {
        ...fetched,
        // Thread hydration is the one place persisted messages enter a
        // fresh runtime with no live turn; drop any tool-call part left
        // running by a stream that died mid call so the session does not
        // load already wedged as "generating". See
        // `sanitizeRunningToolCalls`.
        messages: sanitizeRunningToolCalls(fetched.messages),
      };
    },
  });

type ChatThreadRecapFetched = {
  recap: string | null;
};

const fetchThreadRecap = async (
  threadRef: ChatThreadRef,
): Promise<ChatThreadRecapFetched> => {
  const response = await api.chat
    .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
    .recap.post(undefined, {
      query:
        threadRef.scope === "workspace"
          ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
          : {},
    });

  if (response.error) {
    // A recap is a non-critical nicety: surface nothing on failure,
    // but keep the error in telemetry.
    getAnalytics().captureError(toAPIError(response.error), {
      fingerprintKey: "fetchThreadRecap:failure",
      scope: { type: "handler", handlerId: "fetchThreadRecap:failure" },
    });
    return { recap: null };
  }

  return { recap: response.data.recap };
};

type ChatThreadRecapOptionsArgs = {
  activeOrganizationId: string;
  enabled: boolean;
  lastMessageId: string;
  threadRef: ChatThreadRef;
};

export const chatThreadRecapOptions = ({
  activeOrganizationId,
  enabled,
  lastMessageId,
  threadRef,
}: ChatThreadRecapOptionsArgs) =>
  queryOptions({
    enabled,
    // A given message tail yields a stable recap (cached server-side),
    // so never auto-refetch; a new message produces a new cache key.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.recap(activeOrganizationId, threadRef, lastMessageId),
    queryFn: async () => await fetchThreadRecap(threadRef),
  });

type ChatThreadSuggestedPromptsFetched = {
  prompts: string[];
};

const fetchThreadSuggestedPrompts = async (
  threadRef: ChatThreadRef,
): Promise<ChatThreadSuggestedPromptsFetched> => {
  const response = await api.chat
    .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
    ["suggested-prompts"].post(undefined, {
      query:
        threadRef.scope === "workspace"
          ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
          : {},
    });

  if (response.error) {
    getAnalytics().captureError(toAPIError(response.error), {
      fingerprintKey: "fetchThreadSuggestedPrompts:failure",
      scope: {
        type: "handler",
        handlerId: "fetchThreadSuggestedPrompts:failure",
      },
    });
    return { prompts: [] };
  }

  return { prompts: response.data.prompts };
};

type ChatThreadSuggestedPromptsOptionsArgs = {
  activeOrganizationId: string;
  enabled: boolean;
  lastMessageId: string;
  threadRef: ChatThreadRef;
};

export const chatThreadSuggestedPromptsOptions = ({
  activeOrganizationId,
  enabled,
  lastMessageId,
  threadRef,
}: ChatThreadSuggestedPromptsOptionsArgs) =>
  queryOptions({
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.suggestedPrompts(
      activeOrganizationId,
      threadRef,
      lastMessageId,
    ),
    queryFn: async () => await fetchThreadSuggestedPrompts(threadRef),
  });

const fetchChatModelOptions = async () => {
  const response = await api.chat["model-options"].get();

  return unwrapApiResponse(response);
};

export type ChatModelBenchmarkOption = Awaited<
  ReturnType<typeof fetchChatModelOptions>
>["benchmarkOptions"][number];

// The composer (+) menu's Models submenu fetches this lazily (only once the
// menu opens) rather than eagerly on composer mount, so opening the chat
// surface never fires the request for users who never touch the picker.
export const modelOptionsOptions = (activeOrganizationId: string) =>
  queryOptions({
    queryKey: chatKeys.modelOptions(activeOrganizationId),
    staleTime: STALE_TIME.FIVE.MINUTES,
    queryFn: async () => await fetchChatModelOptions(),
  });

export const groupedChatThreadsOptions = ({
  activeOrganizationId,
  search,
  userId,
  workspaceId,
}: GroupedChatThreadsKey) => {
  const normalizedSearch = search?.trim() || undefined;
  return infiniteQueryOptions({
    queryKey: chatKeys.groupedThreads({
      activeOrganizationId,
      search: normalizedSearch,
      userId,
      workspaceId,
    }),
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    refetchOnWindowFocus: false,
    queryFn: async ({ pageParam, signal }): Promise<GroupedChatThreadsPage> =>
      await fetchGroupedChatThreads({
        cursor: pageParam,
        search: normalizedSearch,
        signal,
        workspaceId,
      }),
    initialPageParam: stringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
};

const fetchChatThreadTitle = async ({
  threadId,
  workspaceId,
}: ChatThreadTitleKey): Promise<string> => {
  const response = await api.chat
    .threads({ threadId: toSafeId<"chatThread">(threadId) })
    .title.get({
      query: workspaceId
        ? { workspaceId: toSafeId<"workspace">(workspaceId) }
        : {},
    });

  return unwrapApiResponse(response).title;
};

type ChatDraftMetaOptionsArgs = {
  activeOrganizationId: string;
  threadRef: ChatThreadRef;
};

// Standalone, non-suspense fetch of a draft thread's metadata for the chat
// home. `chatThreadOptions` is deliberately not reused: it instantiates a
// stateful `Chat<>` inside its queryFn on every miss, and doing that on the
// chat-home render path froze the tab. Web search availability, the model,
// and the context floor come from a plain GET instead.
export const chatDraftMetaOptions = ({
  activeOrganizationId,
  threadRef,
}: ChatDraftMetaOptionsArgs) =>
  queryOptions({
    queryKey: chatKeys.draftMeta(activeOrganizationId, threadRef),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }) => {
      const response = await api.chat
        .threads({ threadId: threadRef.threadId })
        .messages.get({
          query: { allowMissingThread: true },
          fetch: { signal },
        });
      const data = unwrapApiResponse(response);
      return {
        webSearchAvailable: data.webSearchAvailable,
        webSearchEnabled: data.webSearchEnabled,
        model: data.model,
        reasoningEffort: data.reasoningEffort,
        // The draft's cache-stable context floor (system prompt + tools), so
        // the hero meter shows the honest baseline instead of 0% before send.
        context: data.context,
      };
    },
  });

type ChatThreadTitleOptionsArgs = {
  activeOrganizationId: string;
  key: ChatThreadTitleKey;
  /**
   * The server's read of this thread (`chatThreadOptions`), undefined until it
   * resolves. The title is read only once that read reports the row exists: a
   * thread whose first message is still being sent has no row yet, so its
   * GET /title answers 404 and the error would stay on screen after the turn
   * lands. Local message state is never that evidence, which is why this takes
   * the whole server read rather than a flag.
   */
  persistedThread: ChatThreadFetched | undefined;
  /** False when the caller already holds the title (the grouped list). */
  needed?: boolean;
};

// By-id title read for shared chrome (the chat breadcrumb, the floating thread
// card). The grouped-threads list only holds the first loaded pages, so opening
// an older thread that has scrolled out of that window would otherwise leave
// the crumb without a title. The breadcrumb reads the grouped cache first and
// only needs this query on a miss, so a thread already in the list never
// triggers a redundant fetch.
export const chatThreadTitleOptions = ({
  activeOrganizationId,
  key,
  persistedThread,
  needed = true,
}: ChatThreadTitleOptionsArgs) =>
  queryOptions({
    enabled: needed && persistedThread?.threadExists === true,
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.threadTitle(activeOrganizationId, key),
    queryFn: async () => await fetchChatThreadTitle(key),
  });

// Match every cached `chatKeys.groupedThreads` entry, whatever org, user,
// search term and matter filter it carries: the invalidator cannot reconstruct
// those ids, so it walks by structural shape instead.
const matchesGroupedChatThreads = (queryKey: readonly unknown[]): boolean =>
  queryKey.at(0) === "chat" &&
  queryKey.at(3) === "threads" &&
  queryKey.at(4) === "grouped";

export const invalidateGroupedChatThreads = async (queryClient: QueryClient) =>
  await queryClient.invalidateQueries({
    // Refetch mounted history surfaces immediately. Inactive search results
    // become stale and refresh only if the user returns to them, avoiding a
    // request fanout across every cached search after each completed turn.
    refetchType: "active",
    predicate: (query) => matchesGroupedChatThreads(query.queryKey),
  });

export const invalidateChatThreadLists = async ({
  queryClient,
  workspaceId,
}: {
  queryClient: QueryClient;
  workspaceId: string | undefined;
}) =>
  await Promise.all([
    invalidateGroupedChatThreads(queryClient),
    ...(workspaceId
      ? [invalidateWorkspaceActivity(queryClient, workspaceId)]
      : []),
  ]);

/**
 * Whether a query key targets the given chat thread in its own scope:
 * every entry composed from `chatKeys.threadPrefix` (thread page, recap,
 * suggested prompts, the chat-home draft metadata) matches, whatever it
 * appends. Callers that need to touch the same thread's cache — cache
 * writers as well as invalidators — use this instead of restating the
 * positions, so a prefix change cannot desynchronize them.
 */
export const matchesChatThread = (
  queryKey: readonly unknown[],
  threadRef: ChatThreadRef,
): boolean => {
  if (
    queryKey.at(0) !== "chat" ||
    queryKey.at(2) !== "thread" ||
    queryKey.at(3) !== threadRef.scope
  ) {
    return false;
  }

  if (threadRef.scope === "global") {
    return queryKey.at(4) === threadRef.threadId;
  }

  return (
    queryKey.at(4) === threadRef.workspaceId &&
    queryKey.at(5) === threadRef.threadId
  );
};

export const invalidateChatThread = async ({
  queryClient,
  threadRef,
}: {
  queryClient: QueryClient;
  threadRef: ChatThreadRef;
}) =>
  await queryClient.invalidateQueries({
    predicate: (query) => matchesChatThread(query.queryKey, threadRef),
  });

/**
 * Whether a query key targets the given chat thread under any
 * scope. Exported for tests; the runtime uses it via
 * `invalidateChatThreadAcrossScopes` below.
 */
export const matchesChatThreadAcrossScopes = (
  queryKey: readonly unknown[],
  threadId: ChatThreadId,
): boolean => {
  if (queryKey.at(0) !== "chat" || queryKey.at(2) !== "thread") {
    return false;
  }
  // queryKey.at(1) is the orgId; we accept any value here since
  // the predicate is used to invalidate the same thread across
  // surfaces (and orgs) when scope changes.
  const scope = queryKey.at(3);
  if (scope === "global") {
    return queryKey.at(4) === threadId;
  }
  if (scope === "workspace") {
    return queryKey.at(5) === threadId;
  }
  return false;
};

/**
 * Invalidate every cached query for a chat thread regardless of
 * scope. Used when a thread moves between the standalone /chat
 * surface and the inspector tab — the destination surface uses a
 * different cache key (the scope is part of the key), so the old
 * scope's entry would otherwise serve stale data on the next
 * visit. Scoped by `threadId` only because that's the durable
 * identity; scope+workspace are surface-bound. `refetchType: "none"`
 * marks the entries stale without refetching a still-observed one, so a
 * cache seed survives until the destination surface reads it.
 */
export const invalidateChatThreadAcrossScopes = async ({
  queryClient,
  refetchType,
  threadId,
}: {
  queryClient: QueryClient;
  refetchType?: InvalidateQueryFilters["refetchType"];
  threadId: ChatThreadId;
}) =>
  await queryClient.invalidateQueries({
    predicate: (query) =>
      matchesChatThreadAcrossScopes(query.queryKey, threadId),
    ...(refetchType === undefined ? {} : { refetchType }),
  });

/**
 * Apply a persisted model-selection change to one query's cache entry, then
 * invalidate the thread across scopes so any other cached view (inspector
 * tab, other scope) picks it up too. `queryKey` must come from a
 * `queryOptions()` call (its data type is inferred from the key's tag), so
 * this only accepts a cache entry shaped like `{ model, reasoningEffort }`;
 * exactly what `chatThreadOptions` and the draft `/chat` composer's meta
 * query return. Shared by every composer surface with a Models submenu so
 * the cache update and invalidation pairing can't drift again.
 */
export const applyChatModelChange = ({
  model,
  reasoningEffort,
  queryClient,
  queryKey,
  threadId,
}: {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  queryClient: QueryClient;
  queryKey: DataTag<
    QueryKey,
    { model: string | null; reasoningEffort: ReasoningEffort | null },
    Error
  >;
  threadId: ChatThreadId;
}): void => {
  queryClient.setQueryData(queryKey, (prev) =>
    prev ? { ...prev, model, reasoningEffort } : prev,
  );
  detached(
    invalidateChatThreadAcrossScopes({ queryClient, threadId }),
    "chat-queries.invalidate-chat-thread-across-scopes",
  );
};
