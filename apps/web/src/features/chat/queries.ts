import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { DataTag, QueryClient, QueryKey } from "@tanstack/react-query";

import type { ReasoningEffort } from "@stll/ai-catalog";
import {
  DOCX_SUGGESTION_SURFACE,
  type DocxSuggestionSurface,
} from "@stll/api-contract";

import type { ChatContextUsage } from "@/components/chat/chat-context-meter";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  isChatTurnInFlight,
  sanitizeRunningToolCalls,
} from "@/components/chat/chat-ui-tools";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { createChatThreadId, toChatThreadId } from "@/lib/chat-thread-ref";
import { STALE_TIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { emitDevCanaryError } from "@/lib/dev-canary";
import { APIError, toAPIError, unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";
import { invalidateWorkspaceActivity } from "@/lib/workspaces/queries";

import { chatKeys, getChatRuntimeContextKind } from "./chat-query-contract";
import type {
  ChatThreadKey,
  ChatThreadOptionsContext,
  ChatThreadOptionsInput,
  ChatThreadTitleKey,
  FileChatThreadKey,
  GroupedChatThreadsKey,
  TemplateChatThreadKey,
} from "./chat-query-contract";
import {
  createChatRuntime,
  LifecycleRegistry,
  resetChatRequestStateForTests,
} from "./chat-runtime";
import type { ChatRuntime } from "./chat-runtime";

const CHAT_THREADS_PAGE_SIZE = 50;

type ThreadFetch = {
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

  if (response.error) {
    const error = toAPIError(response.error);

    if (allowMissingThread && APIError.is(error) && error.status === 404) {
      return {
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

    throw error;
  }

  return {
    messages: response.data.messages,
    olderCursor: response.data.olderCursor,
    contextMatterIds: response.data.contextMatterIds,
    lastActivityAt: response.data.lastActivityAt,
    threadRevision: response.data.threadRevision,
    threadExists: response.data.threadExists,
    usedAnonymization: response.data.usedAnonymization,
    webSearchAvailable: response.data.webSearchAvailable,
    webSearchEnabled: response.data.webSearchEnabled,
    model: response.data.model,
    reasoningEffort: response.data.reasoningEffort,
    context: response.data.context,
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

  const data = unwrapEden(response);

  return {
    messages: data.messages,
    olderCursor: data.olderCursor,
  };
};

const fetchGroupedChatThreads = async ({
  cursor,
  search,
  signal,
}: {
  cursor?: string | undefined;
  search?: string | undefined;
  signal?: AbortSignal | undefined;
} = {}) => {
  const response = await api.chat.threads.get({
    ...(signal !== undefined && { fetch: { signal } }),
    query: {
      limit: CHAT_THREADS_PAGE_SIZE,
      ...(cursor !== undefined && { cursor }),
      ...(search !== undefined && { search }),
    },
  });

  return unwrapEden(response);
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
  /** The rest mirror `ChatThreadFetched` so the initial message page the
   *  server already loaded (see `read-file-thread.ts` /
   *  `resolve-file-thread.ts`) can seed `chatThreadOptions`' cache
   *  directly, collapsing the lookup -> GET /messages waterfall into one
   *  round trip. */
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

  const data = unwrapEden(response);

  return {
    threadId: data.threadId === null ? null : toChatThreadId(data.threadId),
    messages: data.messages,
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

  return toChatThreadId(unwrapEden(response).threadId);
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

/**
 * Test-only escape hatch. The module-level caches are intentionally
 * not cleared automatically; this helper resets them between unit
 * tests so each one starts hermetically.
 */
export const __resetChatRequestStateForTests = (): void => {
  resetChatRequestStateForTests();
  chatRuntimeRegistry.clear();
};

export type ChatThreadFetched = {
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
      messages: sanitizeRunningToolCalls(fetched.messages),
      olderCursor: fetched.olderCursor,
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
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- `hasDocxEditSurface` deliberately excluded from this query's key: the file-thread identity it resolves is the same regardless of docx-vs-pdf, it only steers which sibling `chatThreadOptions` cache key the queryFn seeds below.
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
      const previous = client.getQueryData<FileChatThreadBinding>(
        chatKeys.fileThread(activeOrganizationId, key),
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

  const data = unwrapEden(response);
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
        messages: data.messages,
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

export type ChatThreadOptionsArgs = ChatThreadOptionsInput & {
  activeOrganizationId: string;
};

/**
 * Cache-identity key shared by `chatThreadOptions`' `queryKey` and the
 * runtime registry below. Keeping both derivations behind this one
 * helper guarantees a query cache entry and its registered `ChatRuntime`
 * are always addressed by the exact same (org, thread, allowMissingThread,
 * contextKind) tuple — they can drift in content, never in identity.
 */
const chatThreadCacheKey = ({
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

/**
 * Durable identity of the THREAD a registry entry streams into: org +
 * scope (+ workspaceId for workspace scope) + threadId, and nothing
 * else. Deliberately excludes `allowMissingThread`, `contextKind`, and
 * the transport version — those vary per SURFACE (they are query-cache
 * concerns), while a live stream belongs to the thread itself: the
 * cross-fingerprint busy reattach and the rebuild-time cleanup of
 * superseded entries must see every entry for the thread regardless of
 * which surface's query key it was registered under. JSON-encoded so
 * user-controlled ids cannot collide with a separator.
 */
const chatThreadIdentity = ({
  activeOrganizationId,
  key,
}: {
  activeOrganizationId: string;
  key: ChatThreadKey;
}): string =>
  key.scope === "global"
    ? JSON.stringify([activeOrganizationId, key.scope, key.threadId])
    : JSON.stringify([
        activeOrganizationId,
        key.scope,
        key.workspaceId,
        key.threadId,
      ]);

// Every context capability (getter/handler) that changes what a runtime
// SENDS. `allowMissingThread` is excluded: it shapes the fetch, not the
// send, and is already part of the query key.
type ChatContextQueryOnlyKey = "allowMissingThread";
type ChatContextCapabilityKey = Exclude<
  keyof ChatThreadOptionsContext,
  ChatContextQueryOnlyKey
>;

const CHAT_CONTEXT_CAPABILITY_KEYS = [
  "getActiveDecision",
  "getActiveDraft",
  "getActiveExternal",
  "getActiveFile",
  "getActiveSkill",
  "getActiveTemplate",
  "getContextMatterIds",
  "getDocxEditRepresentation",
  "getEditApplyMode",
  "getSendMode",
  "getUserContext",
  "getDocxSuggestionSurface",
] as const satisfies readonly ChatContextCapabilityKey[];

type MissingChatContextCapabilityKey = Exclude<
  ChatContextCapabilityKey,
  (typeof CHAT_CONTEXT_CAPABILITY_KEYS)[number]
>;

true satisfies MissingChatContextCapabilityKey extends never ? true : never;

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
const chatContextCapabilityFingerprint = (
  context: ChatThreadOptionsContext | undefined,
): string =>
  CHAT_CONTEXT_CAPABILITY_KEYS.filter(
    (capability) => context?.[capability] !== undefined,
  ).join(",");

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

/**
 * Server-authoritative freshness signal a runtime was seeded with,
 * remembered alongside its registry entry so a later acquire can tell
 * whether the incoming pure-data fetch carries anything the runtime was
 * not BUILT from. The message id and activity timestamp detect appended or
 * replayed turns; `threadRevision` detects in-place changes to an existing
 * message, such as an approval resolved by another client.
 *
 * INVARIANT: frozen across ordinary stream progress. That staleness is
 * what drives replacement: after a turn finishes, `onFinish` only
 * invalidates the pure-data query (it does NOT evict — see the registry
 * docs for the race that eviction caused); until the refetch lands,
 * acquire compares the stale cached data against this equally stale
 * build-time seed → equal → reattach, and the runtime keeps showing the
 * finished turn it holds internally. Once the refetch lands, the fresh
 * data's signal diverges from this frozen seed → idle rebuild from
 * server-authoritative messages.
 *
 * The sole exception is an authoritative refresh that confirms the same
 * pending approval already held by the runtime. That acknowledgement
 * advances every alias of the runtime to the persisted approval's seed,
 * so resolving the approval locally cannot rebuild from that now-stale
 * pending transcript before the continuation refetch lands. Updating the
 * seed from stream progress itself would break the normal divergence
 * detection above.
 */
type ChatRuntimeSeedSignal = {
  lastActivityAt: string | null;
  lastMessageId: string | null;
  threadRevision: string | null;
};

type ChatRuntimeRegistryEntry = {
  runtime: ChatRuntime;
  seed: ChatRuntimeSeedSignal;
  /**
   * Stringified query key of the pure-data query this entry belongs to.
   * The registry key is this string PLUS the context-capability
   * fingerprint, so one query key can own several entries; the GC sweep
   * in `installChatRuntimeCleanup` uses this field to find all of them
   * (and ONLY them — a removed query must not sweep entries registered
   * under a sibling query key for the same thread).
   */
  queryKeyString: string;
  /**
   * Durable thread identity (see `chatThreadIdentity`), shared by every
   * entry for the thread across query keys and fingerprints. The busy
   * cross-fingerprint reattach and the rebuild-time cleanup of
   * superseded entries match on this, never on `queryKeyString`.
   */
  threadIdentity: string;
};

const toChatRuntimeSeedSignal = (
  data: ChatThreadFetched,
): ChatRuntimeSeedSignal => ({
  lastActivityAt: data.lastActivityAt,
  lastMessageId: data.messages.at(-1)?.id ?? null,
  threadRevision: data.threadRevision,
});

const seedSignalsEqual = (
  left: ChatRuntimeSeedSignal,
  right: ChatRuntimeSeedSignal,
): boolean =>
  left.lastActivityAt === right.lastActivityAt &&
  left.lastMessageId === right.lastMessageId &&
  left.threadRevision === right.threadRevision;

const getPendingToolApprovalIds = (
  messages: readonly PersistedChatMessage[],
): readonly string[] => {
  const message = messages.at(-1);
  if (!message || message.role !== "assistant") {
    return [];
  }

  return message.parts.flatMap((part) =>
    part.type === "tool-call" && part.state === "approval-requested"
      ? [part.id]
      : [],
  );
};

const CHAT_RUNTIME_RECONCILE_DISPOSITION = {
  idle: "idle",
  replaceStaleApproval: "replace-stale-approval",
  retainInFlight: "retain-in-flight",
  retainPendingApproval: "retain-pending-approval",
} as const;

/**
 * Whether a runtime has live work in flight that a rebuild would kill:
 * an active stream (`status` submitted/streaming, `isLoading` covers a
 * locally-pending optimistic send whose response has not started yet),
 * a server-side generation session (`sessionGenerating`), or a running
 * tool call awaiting its result in the latest assistant turn (which
 * `status` alone does not cover — between tool hops the client is
 * technically "ready").
 */
const hasInFlightChatRuntimeWork = (runtime: ChatRuntime): boolean => {
  const snapshot = runtime.getSnapshot();
  const turnInFlight = isChatTurnInFlight({
    messages: snapshot.messages,
    status: snapshot.status,
    turnAbandoned: snapshot.turnAbandoned,
  });
  // A terminal runtime wins over any stale transport signal. In particular,
  // TanStack preserves a partial tool part (and may still report a generation
  // session) after RUN_ERROR, but that turn will never resume.
  if (snapshot.status === "error" || snapshot.turnAbandoned) {
    return false;
  }

  return snapshot.isLoading || snapshot.sessionGenerating || turnInFlight;
};

const getChatRuntimeReconcileDisposition = ({
  data,
  hasAuthoritativeRefresh,
  runtime,
}: {
  data: ChatThreadFetched;
  hasAuthoritativeRefresh: boolean;
  runtime: ChatRuntime;
}) => {
  if (hasInFlightChatRuntimeWork(runtime)) {
    return CHAT_RUNTIME_RECONCILE_DISPOSITION.retainInFlight;
  }

  const pendingApprovalIds = getPendingToolApprovalIds(
    runtime.getSnapshot().messages,
  );
  if (pendingApprovalIds.length === 0) {
    return CHAT_RUNTIME_RECONCILE_DISPOSITION.idle;
  }

  const authoritativeApprovalIds = new Set(
    getPendingToolApprovalIds(data.messages),
  );
  if (pendingApprovalIds.every((id) => authoritativeApprovalIds.has(id))) {
    return CHAT_RUNTIME_RECONCILE_DISPOSITION.retainPendingApproval;
  }

  return hasAuthoritativeRefresh
    ? CHAT_RUNTIME_RECONCILE_DISPOSITION.replaceStaleApproval
    : CHAT_RUNTIME_RECONCILE_DISPOSITION.retainPendingApproval;
};

/**
 * Live `ChatRuntime` instances, keyed by cache identity (see
 * `chatThreadCacheKey`) PLUS context-capability fingerprint (see
 * `chatContextCapabilityFingerprint`). A runtime is built lazily, from
 * whichever caller's live context getters are on hand the first time its
 * key is resolved, and then reused:
 *   - across a component unmount/remount (thread revisit within the pure
 *     data query's `gcTime`) so an in-flight stream stays attached — see
 *     `useChatThreadRuntime`;
 *   - across the `/chat` landing page's route-handoff send, which calls
 *     `acquireChatRuntime` directly (no mounted component yet) to start
 *     the stream before navigating; the destination route's first render
 *     resolves the same key (identical capability set) and reattaches
 *     instead of building a second, competing runtime;
 *   - across SURFACES while a stream is live: a busy runtime is
 *     reattached even from a different capability fingerprint or query
 *     key (moving a chat between the inspector and the main page
 *     mid-stream) — see `findBusyChatRuntimeEntryForThread` and the
 *     alias mechanism in `acquireChatRuntime`.
 *
 * A hit is NOT unconditional: when the runtime is idle and the incoming
 * pure-data fetch carries a signal that diverges from the entry's frozen
 * build-time seed, the entry is rebuilt from the current caller's live
 * getters and fresh messages — see `acquireChatRuntime`. That one rule
 * covers both refresh paths:
 *   - a background refetch (window-refocus staleness, cross-tab/device
 *     invalidation) picked up messages the runtime never saw;
 *   - this runtime's own finished turn: `onFinish` only INVALIDATES the
 *     pure-data query — it must not evict, because the component
 *     re-renders from the runtime's final stream updates BEFORE the
 *     refetch lands, and an evicted entry would make that render's
 *     acquire (still holding pre-send cached data) rebuild from stale
 *     messages, wiping the just-finished turn off the screen until (or
 *     unless) the refetch wins. With the entry left in place, that
 *     interim acquire sees stale-data-equals-stale-seed → reattach, and
 *     the post-refetch acquire sees the divergence → rebuild from
 *     server-authoritative messages with the mounted caller's getters.
 *
 * Entries are swept when TanStack garbage-collects the matching
 * pure-data query (see `installChatRuntimeCleanup`) so a thread opened
 * once and never revisited doesn't hold its runtime — and every message
 * it ever streamed — in memory indefinitely.
 */
const chatRuntimeRegistry = new LifecycleRegistry<
  string,
  ChatRuntimeRegistryEntry
>();

const advanceAcknowledgedApprovalSeed = ({
  runtime,
  seed,
  threadIdentity,
}: {
  runtime: ChatRuntime;
  seed: ChatRuntimeSeedSignal;
  threadIdentity: string;
}): void => {
  for (const entry of chatRuntimeRegistry.values()) {
    if (entry.runtime === runtime && entry.threadIdentity === threadIdentity) {
      entry.seed = seed;
    }
  }
};

/**
 * Registry key: query-key string + capability fingerprint. IDLE entries
 * never cross capability sets even when they share a pure-data cache
 * entry; BUSY entries do — see `findBusyChatRuntimeEntryForThread`.
 */
const toChatRuntimeRegistryKey = (
  queryKeyString: string,
  context: ChatThreadOptionsContext | undefined,
): string => `${queryKeyString}#${chatContextCapabilityFingerprint(context)}`;

/**
 * BUSYNESS OVERRIDES CAPABILITY SPLITTING. The fingerprint keeps idle
 * runtimes from crossing capability sets because what matters there is
 * the NEXT send: it must be configured by the acquiring surface's own
 * getters. A busy runtime is different — its in-flight turn was already
 * configured by the surface that started it, so reattaching another
 * surface to it for display cannot mis-scope anything, while NOT
 * reattaching would hide a live stream: moving a chat between surfaces
 * mid-stream (inspector "move to main"/"move to side") lands on a
 * surface whose fingerprint differs (the inspector always passes
 * `getActiveDecision`; the page does not), and an exact-fingerprint
 * lookup alone would miss the streaming runtime and rebuild from stale
 * data. Once the turn finishes, `onFinish` invalidates, the refetch
 * diverges the seed, and the idle reconcile rebuilds under the
 * acquiring surface's own fingerprint with its own getters — capability
 * purity is restored at exactly the moment it matters again.
 *
 * Matched on THREAD identity, not query key: the query key embeds
 * `contextKind` (and `allowMissingThread`), so an inspector surface
 * opened with `getActiveSkill` registers under an "active-skill" query
 * key while the main page acquires the same thread under the "plain"
 * one — a query-key-scoped scan would miss that live stream entirely.
 *
 * Sends are serialized per thread in the UI, so two busy entries for
 * one thread should not occur; if state ever degrades to that, the
 * first entry in Map insertion order wins, deterministically.
 */
const findBusyChatRuntimeEntryForThread = ({
  data,
  seed,
  threadIdentity,
}: {
  data: ChatThreadFetched;
  seed: ChatRuntimeSeedSignal;
  threadIdentity: string;
}): ChatRuntimeRegistryEntry | undefined => {
  for (const entry of chatRuntimeRegistry.values()) {
    if (entry.threadIdentity !== threadIdentity) {
      continue;
    }
    const hasAuthoritativeRefresh = !seedSignalsEqual(entry.seed, seed);
    const disposition = getChatRuntimeReconcileDisposition({
      data,
      hasAuthoritativeRefresh,
      runtime: entry.runtime,
    });
    if (
      disposition !== CHAT_RUNTIME_RECONCILE_DISPOSITION.retainInFlight &&
      disposition !== CHAT_RUNTIME_RECONCILE_DISPOSITION.retainPendingApproval
    ) {
      continue;
    }
    if (
      disposition ===
        CHAT_RUNTIME_RECONCILE_DISPOSITION.retainPendingApproval &&
      hasAuthoritativeRefresh
    ) {
      advanceAcknowledgedApprovalSeed({
        runtime: entry.runtime,
        seed,
        threadIdentity,
      });
    }
    return entry;
  }
  return undefined;
};

const isChatThreadQueryKey = (queryKey: unknown): boolean =>
  Array.isArray(queryKey) &&
  queryKey.at(0) === "chat" &&
  queryKey.at(2) === "thread";

const chatRuntimeCleanupInstalledClients = new WeakSet<QueryClient>();

/**
 * Wire `chatRuntimeRegistry` eviction to the query cache's own GC.
 * Idempotent per `QueryClient` (mirrors `installPDFDocumentCleanup`);
 * call once, e.g. wherever the app's `QueryClient` is constructed.
 */
export const installChatRuntimeCleanup = (queryClient: QueryClient): void => {
  if (chatRuntimeCleanupInstalledClients.has(queryClient)) {
    return;
  }
  chatRuntimeCleanupInstalledClients.add(queryClient);

  queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "removed" ||
      !isChatThreadQueryKey(event.query.queryKey)
    ) {
      return;
    }
    // One query key can own several registry entries (one per context
    // capability fingerprint), so sweep by the entry's recorded query
    // key rather than deleting a single map key. Deleting during Map
    // iteration is safe per spec.
    const removedKeyString = JSON.stringify(event.query.queryKey);
    for (const [registryKey, entry] of chatRuntimeRegistry) {
      if (entry.queryKeyString === removedKeyString) {
        chatRuntimeRegistry.delete(registryKey);
        chatRuntimeRebuildTimes.delete(entry.threadIdentity);
      }
    }
  });
};

// Dev-only rebuild-churn canary. A priority-4 rebuild is expected a handful
// of times around a turn boundary (one per surface per authoritative
// refetch). A rebuild on every render — the registry failing to converge —
// swaps the store identity under `useSyncExternalStore` each pass and
// presents in the field as an unattributed render storm. Counting rebuilds
// per thread in a sliding window turns that failure mode into a named
// canary error (which the e2e `browserErrors` fixture escalates to a CI
// failure, like the render-storm canary). Entries evict with the thread's
// runtime entries in `installChatRuntimeCleanup`.
const CHAT_RUNTIME_REBUILD_CHURN_WINDOW_MS = 2000;
const CHAT_RUNTIME_REBUILD_CHURN_THRESHOLD = 10;
const chatRuntimeRebuildTimes = new LifecycleRegistry<string, number[]>();

const trackChatRuntimeRebuildChurn = (threadIdentity: string): void => {
  if (!import.meta.env.DEV) {
    return;
  }
  const now = performance.now();
  const previous = chatRuntimeRebuildTimes.get(threadIdentity);
  const recent =
    previous === undefined
      ? []
      : previous.filter(
          (time) => now - time < CHAT_RUNTIME_REBUILD_CHURN_WINDOW_MS,
        );
  recent.push(now);
  chatRuntimeRebuildTimes.set(threadIdentity, recent);
  if (recent.length === CHAT_RUNTIME_REBUILD_CHURN_THRESHOLD) {
    emitDevCanaryError(
      "chat-runtime-churn",
      `rebuilt the chat runtime for thread ${threadIdentity} ` +
        `${String(CHAT_RUNTIME_REBUILD_CHURN_THRESHOLD)} times in ${String(CHAT_RUNTIME_REBUILD_CHURN_WINDOW_MS)}ms. ` +
        "acquireChatRuntime is not converging: each render sees a seed that " +
        "differs from the cached thread data, rebuilds, and re-renders. Compare " +
        "the entry seed against toChatRuntimeSeedSignal(data) at the rebuild site.",
    );
  }
};

export type AcquireChatRuntimeArgs = {
  activeOrganizationId: string;
  context: ChatThreadOptionsContext | undefined;
  /**
   * The pure-data result of the matching `chatThreadOptions` query.
   * Seeds a freshly built runtime (`messages` are already sanitized by
   * the queryFn) and provides the freshness signal for the idle
   * reconcile on a registry hit.
   */
  data: ChatThreadFetched;
  key: ChatThreadKey;
  queryClient: QueryClient;
};

/**
 * Resolve the live `ChatRuntime` for a thread, building and registering
 * one from `context`'s live getters on a registry miss. See
 * `chatRuntimeRegistry`'s docs for the full reuse/replacement lifecycle.
 *
 * Reattach priority, reconciled against `data`'s freshness signal:
 *   1. Runtime with in-flight work under the caller's exact registry key:
 *      returned regardless of signal. Never replace mid-stream —
 *      this is what keeps an in-flight chat alive across navigation, and
 *      what makes the `/chat` route-handoff work: the handoff sender
 *      registers the runtime and starts the stream BEFORE navigating, so
 *      the destination page's acquire (identical fingerprint) lands here
 *      and reattaches instead of rebuilding.
 *      A pending approval is retained while the query still carries the
 *      runtime's pre-send seed, or when a refreshed transcript contains every
 *      pending tool-call id. A refreshed mismatch replaces stale local state.
 *   2. Runtime with in-flight work under ANY other registry key for the
 *      same THREAD
 *      (any fingerprint, any query key — the inspector's active-skill
 *      surface and the main page's plain surface use different query
 *      keys for one thread): returned regardless of signal — see
 *      `findBusyChatRuntimeEntryForThread` (in-flight work overrides
 *      capability splitting). Checked BEFORE the idle exact reattach so
 *      a stale idle entry left under the acquiring surface's own key can
 *      never shadow a live stream running under a foreign one. The
 *      reattach also records an ALIAS entry under the ACQUIRER's
 *      registry key — same runtime object, the source entry's seed — so
 *      that after the stream finishes but before the refetch lands, the
 *      acquirer's stale-data render takes the idle seed-equal exact hit
 *      (priority 3) instead of missing and rebuilding from pre-send
 *      messages (the finding-1 race, reintroduced through this path
 *      without the alias). Idempotent across renders: once the alias
 *      exists, subsequent busy renders resolve it at priority 1.
 *   3. Idle exact-key runtime, signal equal to the entry's build-time
 *      seed: returned as-is. This covers a plain revisit AND the window
 *      between a turn's `onFinish` (which only invalidates) and its
 *      refetch landing: cached data is still pre-send, the frozen seed
 *      is too, so the runtime — which holds the finished turn
 *      internally — is kept and the transcript never flickers back.
 *   4. Rebuild: the refetch (or a cross-tab/device background refetch)
 *      delivered messages the exact-key runtime was not built from, or
 *      no entry exists. Build from the CURRENT caller's live getters and
 *      fresh sanitized messages (the pre-registry design rebuilt on
 *      every queryFn run; this is the idle-only equivalent). This is
 *      also forced when an authoritative transcript resolves a pending
 *      approval in place without changing the tail message id or timestamp.
 *      Rebuild is also the moment a busy-reattached foreign runtime — or a
 *      route-handoff runtime — sheds its originating surface's getters
 *      in favour of the mounted caller's. Superseded same-thread entries
 *      (idle, diverged seed — finished streams whose data has been
 *      refetched, including both a busy-reattach's SOURCE entry and any
 *      ALIAS of it under other keys) are explicitly deleted here so one
 *      thread does not accumulate a dead entry per fingerprint;
 *      seed-equal entries are kept — they belong to a concurrently
 *      mounted surface built from the same fresh data.
 */
export const acquireChatRuntime = ({
  activeOrganizationId,
  context,
  data,
  key,
  queryClient,
}: AcquireChatRuntimeArgs): ChatRuntime => {
  const queryKeyString = JSON.stringify(
    chatThreadCacheKey({ activeOrganizationId, context, key }),
  );
  const registryKey = toChatRuntimeRegistryKey(queryKeyString, context);
  const threadIdentity = chatThreadIdentity({ activeOrganizationId, key });
  const seed = toChatRuntimeSeedSignal(data);
  const existing = chatRuntimeRegistry.get(registryKey);
  const existingDisposition =
    existing === undefined
      ? null
      : getChatRuntimeReconcileDisposition({
          data,
          hasAuthoritativeRefresh: !seedSignalsEqual(existing.seed, seed),
          runtime: existing.runtime,
        });
  // Priority 1: busy runtime under the exact registry key.
  if (
    existing !== undefined &&
    existingDisposition === CHAT_RUNTIME_RECONCILE_DISPOSITION.retainInFlight
  ) {
    return existing.runtime;
  }
  if (
    existing !== undefined &&
    existingDisposition ===
      CHAT_RUNTIME_RECONCILE_DISPOSITION.retainPendingApproval
  ) {
    if (!seedSignalsEqual(existing.seed, seed)) {
      advanceAcknowledgedApprovalSeed({
        runtime: existing.runtime,
        seed,
        threadIdentity,
      });
    }
    return existing.runtime;
  }
  // Priority 2: busy runtime under any other registry key for this
  // thread. Record an alias under the acquirer's key (same runtime, the
  // source's seed) so the post-finish stale render reattaches via the
  // seed-equal exact hit instead of rebuilding from pre-send messages.
  // Overwrites a stale idle exact entry on purpose: the user is looking
  // at the streaming runtime now, so a later seed-equal hit must return
  // it, not the pre-stream leftover.
  const busyEntry = findBusyChatRuntimeEntryForThread({
    data,
    seed,
    threadIdentity,
  });
  if (busyEntry !== undefined) {
    chatRuntimeRegistry.set(registryKey, {
      runtime: busyEntry.runtime,
      seed: busyEntry.seed,
      queryKeyString,
      threadIdentity,
    });
    return busyEntry.runtime;
  }
  // Priority 3: idle exact-key reattach on an unchanged signal.
  if (
    existing !== undefined &&
    existingDisposition !==
      CHAT_RUNTIME_RECONCILE_DISPOSITION.replaceStaleApproval &&
    seedSignalsEqual(existing.seed, seed)
  ) {
    return existing.runtime;
  }
  // Priority 4: rebuild. Every entry for this thread is idle here (the
  // busy scan above found none), so drop superseded same-thread entries —
  // idle, diverged seed — before registering the replacement; the `set`
  // at the end replaces the exact-key entry atomically.
  trackChatRuntimeRebuildChurn(threadIdentity);
  for (const [staleKey, entry] of chatRuntimeRegistry) {
    if (
      staleKey !== registryKey &&
      entry.threadIdentity === threadIdentity &&
      !seedSignalsEqual(entry.seed, seed)
    ) {
      chatRuntimeRegistry.delete(staleKey);
    }
  }

  const refreshPersistedThread = () => {
    detached(
      Promise.all([
        invalidateChatThread({ queryClient, threadRef: key }),
        invalidateChatThreadLists({
          queryClient,
          workspaceId: key.scope === "workspace" ? key.workspaceId : undefined,
        }),
      ]),
      "chat-queries.invalidate-chat-thread",
    );
  };
  const runtime = createChatRuntime({
    context,
    initialMessages: data.messages,
    key,
    onError: (error) => {
      getAnalytics().captureError(error);
      // The server persists a failed terminal outcome before emitting
      // RUN_ERROR. Reconcile the ephemeral TanStack error runtime with that
      // durable message metadata just as a successful finish does.
      refreshPersistedThread();
    },
    onFinish: () => {
      // Invalidate only — do NOT evict the registry entry here. The
      // component re-renders from the runtime's final stream updates
      // before this invalidation's refetch lands; with the entry gone
      // that render's acquire would be a registry MISS against still
      // stale cached data and would rebuild from pre-send messages,
      // wiping the finished turn until the refetch wins (or forever if
      // it fails). Kept in place, the entry reattaches seed-equal until
      // the refetch lands, then the idle reconcile replaces it.
      refreshPersistedThread();
    },
  });
  chatRuntimeRegistry.set(registryKey, {
    runtime,
    seed,
    queryKeyString,
    threadIdentity,
  });
  return runtime;
};

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
    getAnalytics().captureError(toAPIError(response.error));
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
    getAnalytics().captureError(toAPIError(response.error));
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

  return unwrapEden(response);
};

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
}: GroupedChatThreadsKey) => {
  const normalizedSearch = search?.trim() || undefined;
  return infiniteQueryOptions({
    queryKey: chatKeys.groupedThreads({
      activeOrganizationId,
      search: normalizedSearch,
    }),
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    refetchOnWindowFocus: false,
    queryFn: async ({ pageParam, signal }): Promise<GroupedChatThreadsPage> =>
      await fetchGroupedChatThreads({
        cursor: pageParam,
        search: normalizedSearch,
        signal,
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

  return unwrapEden(response).title;
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
      const data = unwrapEden(response);
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
  enabled: boolean;
  key: ChatThreadTitleKey;
};

// By-id title read for shared chrome (the chat breadcrumb). The grouped-threads
// list only holds the first loaded pages, so opening an older thread that has
// scrolled out of that window would otherwise leave the crumb without a title.
// The breadcrumb reads the grouped cache first and only enables this query on a
// miss, so a thread already in the list never triggers a redundant fetch.
export const chatThreadTitleOptions = ({
  activeOrganizationId,
  enabled,
  key,
}: ChatThreadTitleOptionsArgs) =>
  queryOptions({
    enabled,
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.threadTitle(activeOrganizationId, key),
    queryFn: async () => await fetchChatThreadTitle(key),
  });

// Match every cached `chatKeys.groupedThreads` entry, whatever org and search
// term it carries: the invalidator cannot reconstruct the org id, so it walks
// by structural shape instead.
const matchesGroupedChatThreads = (queryKey: readonly unknown[]): boolean =>
  queryKey.at(0) === "chat" &&
  queryKey.at(2) === "threads" &&
  queryKey.at(3) === "grouped";

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
 * identity; scope+workspace are surface-bound.
 */
export const invalidateChatThreadAcrossScopes = async ({
  queryClient,
  threadId,
}: {
  queryClient: QueryClient;
  threadId: ChatThreadId;
}) =>
  await queryClient.invalidateQueries({
    predicate: (query) =>
      matchesChatThreadAcrossScopes(query.queryKey, threadId),
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
