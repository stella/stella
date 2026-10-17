import type { QueryClient } from "@tanstack/react-query";

import { isChatTurnInFlight } from "@/components/chat/chat-ui-tools";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { getChatRuntimeContextKind } from "@/features/chat/chat-query-contract";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { emitDevCanaryError } from "@/lib/dev-canary";
import { LifecycleRegistry } from "@/stores/lifecycle-registry";

import type {
  ChatThreadKey,
  ChatThreadOptionsContext,
} from "./chat-query-contract";
import {
  createChatRuntime,
  resetChatRequestStateForTests,
} from "./chat-runtime";
import type { ChatRuntime } from "./chat-runtime";
import {
  chatContextCapabilityFingerprint,
  chatThreadCacheKey,
  invalidateChatThread,
  invalidateChatThreadLists,
} from "./queries";
import type { ChatThreadFetched } from "./queries";

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
 * `contextKind` (and `allowMissingThread`), so a surface whose context
 * selects another kind (an open file, a draft, an external document)
 * registers under that kind's query key while the main page acquires
 * the same thread under the "plain" one — a query-key-scoped scan would
 * miss that live stream entirely.
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
 * Installed when the first runtime is acquired, before an entry is registered.
 */
const installChatRuntimeCleanup = (queryClient: QueryClient): void => {
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
  installChatRuntimeCleanup(queryClient);
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
    activeTurnId: data.activeTurnId,
    context,
    initialMessages: data.messages,
    key,
    onError: (error) => {
      getAnalytics().captureError(error, {
        fingerprintKey: "acquireChatRuntime:failure",
        scope: {
          type: "handler",
          handlerId: `chat-runtime.${key.scope}.${getChatRuntimeContextKind(context)}`,
        },
      });
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
    reloadThread: refreshPersistedThread,
  });
  chatRuntimeRegistry.set(registryKey, {
    runtime,
    seed,
    queryKeyString,
    threadIdentity,
  });
  return runtime;
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
