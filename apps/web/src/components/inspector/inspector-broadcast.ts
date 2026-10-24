import { Result } from "better-result";
import type { StoreApi } from "zustand";

import { isTaskStatus } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import { isActiveSkillContext } from "@/components/inspector/inspector-active-skill";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { normalizeInspectorGroupAssignments } from "@/components/inspector/inspector-groups.logic";
import {
  inspectorMinimizedEntry,
  inspectorRestorePendingEntry,
  inspectorStateEntry,
} from "@/components/inspector/inspector-storage-keys";
import {
  type ChatTab,
  FILE_FACETS,
  type FileTab,
  type InspectorTab,
  type InspectorTabGroup,
  type InspectorTabsStore,
  parseSkillResourceSource,
  type TaskTab,
} from "@/components/inspector/inspector-store-types";
import {
  isGenericInspectorTab,
  reconcileSharedInspectorTabs,
} from "@/components/inspector/inspector-tabs-slice";
import {
  getInspectorPersistenceReference,
  getInspectorView,
} from "@/components/inspector/view-registry";
import "@/components/inspector/inspector-persistence-references";
import {
  decisionChatKey,
  isOptionalLegalDocumentChatKey,
} from "@/features/chat/legal-document-chat-key";
import { adoptRestoredLegalDocumentChatThreads } from "@/features/chat/legal-document-chat-threads";
import type { RestoredLegalDocumentChatThread } from "@/features/chat/legal-document-chat-threads";
import { getTranslator } from "@/i18n/i18n-store";
import {
  isCurrentStorageOwner,
  onStorageOwnerChange,
  storageOwner,
} from "@/lib/account/user-scoped-storage";
import { getAnalytics } from "@/lib/analytics/provider";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  readPersistedState,
  removePersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";
import { createUuid } from "@/lib/uuid";

export type InspectorBroadcastScope = {
  userId: string;
  organizationId: string;
};

type InspectorTabsRequestMessage = {
  type: "inspector-tabs:request";
  senderId: string;
};

type InspectorTabsSyncMessage = {
  type: "inspector-tabs:sync";
  senderId: string;
  recipientId?: string | undefined;
  updatedAt: number;
  tabs: InspectorBroadcastTab[];
  groups?: InspectorTabGroup[] | undefined;
  groupAssignments?: Record<string, string | null> | undefined;
};

/**
 * A chat tab written before a conversation was keyed by its document rather
 * than by a decision id. `normalizeInspectorBroadcastTab` converts it on the
 * way in, so a decision chat open across the upgrade keeps its one
 * conversation instead of restoring unbound beside a fresh one.
 *
 * Remove this member, its validation and its conversion once no browser can
 * still be restoring a tab set written before that change: the value is
 * session-local, so a client that has opened the app since carries the new
 * field.
 */
type LegacyDecisionChatTab = ChatTab & { activeDecisionId: string };

type InspectorBroadcastTab =
  | InspectorTab
  | (Omit<TaskTab, "creationStatus"> & { creationStatus?: undefined })
  | LegacyDecisionChatTab;

type InspectorBroadcastMessage =
  InspectorTabsRequestMessage | InspectorTabsSyncMessage;

type InspectorBroadcastSession = {
  dispose: () => void;
  release: () => void;
  retain: () => void;
  scopeKey: string;
};

type InspectorBroadcastClock = {
  senderId: string;
  updatedAt: number;
};

const INSPECTOR_TABS_CHANNEL_PREFIX = "stella:inspector-tabs:v1";
const noopInspectorBroadcastCleanup = () => undefined;

const readPersistedMinimized = (scope: InspectorBroadcastScope): boolean =>
  readPersistedState(inspectorMinimizedEntry, scope);

const writePersistedMinimized = (
  scope: InspectorBroadcastScope,
  minimized: boolean,
): void => {
  // Best effort like every layout preference: blocked storage keeps the
  // in-memory state and the next start opens at the default.
  writePersistedState(inspectorMinimizedEntry, scope, minimized).unwrapOr(
    undefined,
  );
};

// Restored tabs mount the docked viewer at load. If a restore keeps the page
// from ever settling, every reload would restore the same tabs again; a
// session flag set before the restore and cleared once the page has settled
// tells the next start to restore minimized instead.
const RESTORE_SETTLE_DELAY_MS = 2000;

// Everything one page load owns. In the browser a reload starts the module
// again; tests model one by replacing the whole record, so nothing an earlier
// page held (a pending settle, an unreleased viewer hold, a store attachment)
// carries into the next.
type PageLoad = {
  // The flag records which page load set it. Another start in the same page (a
  // shell that attaches the store after a client navigation) sees this page's
  // own unsettled restore, which is not a stalled earlier load.
  readonly id: string;
  // Viewers the restore mounted that have not loaded their document yet. The
  // flag stays until every one has loaded and the page then stays responsive:
  // a document that arrives after the delay could still stall the page.
  restoreHolds: number;
  settlingScope: InspectorBroadcastScope | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
  readonly scopeOwnership: WeakMap<StoreApi<InspectorTabsStore>, string>;
};

const createPageLoad = (): PageLoad => ({
  id: createUuid(),
  restoreHolds: 0,
  settlingScope: null,
  settleTimer: null,
  scopeOwnership: new WeakMap(),
});

let pageLoad = createPageLoad();

const readRestorePending = (scope: InspectorBroadcastScope): boolean => {
  const pendingPageLoad = readPersistedState(
    inspectorRestorePendingEntry,
    scope,
  );
  return pendingPageLoad !== "" && pendingPageLoad !== pageLoad.id;
};

const writeRestorePending = (
  scope: InspectorBroadcastScope,
  pending: boolean,
): void => {
  if (pending) {
    writePersistedState(
      inspectorRestorePendingEntry,
      scope,
      pageLoad.id,
    ).unwrapOr(undefined);
    return;
  }
  removePersistedState(inspectorRestorePendingEntry, scope).unwrapOr(undefined);
};

/** Only the current page load settles its restore: a callback an earlier load
 *  left queued must not clear the flag a later load set. */
const settleRestore = (
  load: PageLoad,
  scope: InspectorBroadcastScope,
): void => {
  if (load === pageLoad && load.settlingScope === scope) {
    writeRestorePending(scope, false);
    load.settlingScope = null;
  }
};

/** Clears the flag once nothing restored is still loading and the page has
 *  stayed responsive for a moment: a busy main thread runs neither the timer
 *  nor the idle callback. */
const scheduleRestoreSettle = (load: PageLoad): void => {
  const scope = load.settlingScope;
  if (load !== pageLoad || scope === null || load.restoreHolds > 0) {
    return;
  }
  if (load.settleTimer !== null) {
    clearTimeout(load.settleTimer);
  }
  load.settleTimer = setTimeout(() => {
    load.settleTimer = null;
    const clear = () => {
      if (load.restoreHolds === 0) {
        settleRestore(load, scope);
      }
    };
    if (typeof globalThis.requestIdleCallback === "function") {
      globalThis.requestIdleCallback(clear);
    } else {
      clear();
    }
  }, RESTORE_SETTLE_DELAY_MS);
};

const clearRestorePendingWhenSettled = (
  scope: InspectorBroadcastScope,
): void => {
  const load = pageLoad;
  load.settlingScope = scope;
  scheduleRestoreSettle(load);
  // A page that can run its pagehide handler is not stuck, so leaving it
  // (a reload, a navigation) settles the restore even inside the delay.
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("pagehide", () => settleRestore(load, scope), {
      once: true,
    });
  }
};

/**
 * Held by a restored viewer from mount until its document has loaded (or
 * failed), so the restore counts as settled only after the viewer is ready.
 * The returned release is idempotent and counts only against the page load
 * that took the hold.
 */
export const holdInspectorRestoreSettle = (): (() => void) => {
  const load = pageLoad;
  load.restoreHolds += 1;
  if (load.settleTimer !== null) {
    clearTimeout(load.settleTimer);
    load.settleTimer = null;
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    load.restoreHolds -= 1;
    scheduleRestoreSettle(load);
  };
};

let inspectorBroadcastSession: InspectorBroadcastSession | null = null;
let failedPersistenceScope: string | null = null;
let persistenceFailureOccurrence = 0;

/** Tests model a reload by starting again in a new page load. */
export const startNewPageLoadForTest = (): void => {
  if (pageLoad.settleTimer !== null) {
    clearTimeout(pageLoad.settleTimer);
    pageLoad.settleTimer = null;
  }
  pageLoad = createPageLoad();
};

/* oxlint-disable unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage does not accept targetOrigin. */
const postInspectorBroadcastMessage = (
  channel: BroadcastChannel,
  message: InspectorBroadcastMessage,
) => {
  channel.postMessage(message);
};
/* oxlint-enable unicorn/require-post-message-target-origin */

const compareInspectorBroadcastClocks = (
  left: InspectorBroadcastClock,
  right: InspectorBroadcastClock,
) => {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }
  if (left.senderId < right.senderId) {
    return -1;
  }
  return left.senderId > right.senderId ? 1 : 0;
};

const getNextInspectorBroadcastClock = (
  previousClock: InspectorBroadcastClock | null,
  senderId: string,
): InspectorBroadcastClock => {
  const now = Temporal.Now.instant().epochMilliseconds;
  if (previousClock === null) {
    return { senderId, updatedAt: now };
  }
  const updatedAt = Math.max(now, previousClock.updatedAt);
  const nextClock = { senderId, updatedAt };
  if (compareInspectorBroadcastClocks(nextClock, previousClock) > 0) {
    return nextClock;
  }
  return { senderId, updatedAt: previousClock.updatedAt + 1 };
};

export const getInspectorTabsBroadcastChannelName = ({
  userId,
  organizationId,
}: InspectorBroadcastScope) =>
  `${INSPECTOR_TABS_CHANNEL_PREFIX}:${organizationId}:${userId}`;

/**
 * The conversations a tab set carries: a chat tab opened about a legal
 * document is that document's conversation, wherever the tab came from.
 */
const legalDocumentChatThreadsIn = (
  tabs: readonly InspectorTab[],
): RestoredLegalDocumentChatThread[] => {
  const threads: RestoredLegalDocumentChatThread[] = [];
  for (const tab of tabs) {
    if (tab.type === "chat" && tab.activeLegalKey !== undefined) {
      threads.push({ documentKey: tab.activeLegalKey, threadId: tab.id });
    }
  }
  return threads;
};

const applySharedInspectorTabs = (
  store: StoreApi<InspectorTabsStore>,
  tabs: InspectorTab[],
  groups: InspectorTabGroup[],
  groupAssignments: Record<string, string | null>,
) => {
  const next = reconcileSharedInspectorTabs(
    store.getState(),
    tabs,
    groups,
    groupAssignments,
  );
  store.setState(next);
  adoptRestoredLegalDocumentChatThreads(legalDocumentChatThreadsIn(next.tabs));
  useInspectorCommandStore
    .getState()
    .clearCommandsForMissingTabs(new Set(next.tabs.map((tab) => tab.id)));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const isOptionalNumber = (value: unknown): value is number | undefined =>
  value === undefined || typeof value === "number";

const isInspectorTabGroup = (value: unknown): value is InspectorTabGroup =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  ((value["type"] === "matter" && typeof value["workspaceId"] === "string") ||
    (value["type"] === "custom" &&
      typeof value["name"] === "string" &&
      typeof value["color"] === "string"));

const isGroupAssignments = (
  value: unknown,
): value is Record<string, string | null> =>
  isRecord(value) &&
  Object.values(value).every(
    (groupId) => groupId === null || typeof groupId === "string",
  );

export const isFileFacet = (
  value: unknown,
): value is NonNullable<FileTab["facet"]> | undefined =>
  value === undefined ||
  (typeof value === "string" && FILE_FACETS.some((facet) => facet === value));

const isMetadataLane = (value: unknown): value is FileTab["metadataLane"] =>
  value === undefined || value === "closed" || value === "expanded";

const isInspectorTab = (value: unknown): value is InspectorBroadcastTab => {
  if (!isRecord(value)) {
    return false;
  }
  const type = value["type"];
  const id = value["id"];
  if (typeof type !== "string" || typeof id !== "string") {
    return false;
  }
  return isInspectorTabType(value, type);
};

const isInspectorTabType = (value: Record<string, unknown>, type: string) => {
  const label = value["label"];
  if (type === "task") {
    return isInspectorTaskTab(value, label);
  }
  if (type === "chat") {
    return isInspectorChatTab(value, label);
  }
  if (type === "external") {
    return isInspectorExternalTab(value, label);
  }
  if (type === "matter") {
    return isInspectorMatterTab(value, label);
  }
  if (type === "skill-resource") {
    return isInspectorSkillResourceTab(value, label);
  }
  if (type === "pdf") {
    return isInspectorPdfTab(value, label);
  }
  return isInspectorViewTab(value, type, label);
};

const isInspectorTaskTab = (value: Record<string, unknown>, label: unknown) => {
  const status = value["status"];
  return (
    typeof label === "string" &&
    (value["creationStatus"] === undefined ||
      value["creationStatus"] === "pending" ||
      value["creationStatus"] === "ready") &&
    typeof value["isNew"] === "boolean" &&
    typeof value["workspaceId"] === "string" &&
    (status === undefined || status === null || isTaskStatus(status))
  );
};

const isInspectorChatTab = (value: Record<string, unknown>, label: unknown) =>
  typeof label === "string" &&
  isOptionalString(value["workspaceId"]) &&
  isStringArray(value["contextMatterIds"]) &&
  isOptionalLegalDocumentChatKey(value["activeLegalKey"]) &&
  (value["started"] === undefined || value["started"] === true) &&
  isOptionalString(value["activeDecisionId"]) &&
  (value["activeSkill"] === undefined ||
    isActiveSkillContext(value["activeSkill"]));

const isInspectorExternalTab = (
  value: Record<string, unknown>,
  label: unknown,
) => {
  const workspaceId = value["workspaceId"];
  return (
    typeof label === "string" &&
    typeof value["chatThreadId"] === "string" &&
    typeof value["url"] === "string" &&
    (workspaceId === null || typeof workspaceId === "string") &&
    isOptionalString(value["connectorSlug"]) &&
    isOptionalString(value["iconHref"]) &&
    isOptionalString(value["provider"]) &&
    isOptionalString(value["snippet"]) &&
    isOptionalString(value["sourceToolName"]) &&
    isOptionalString(value["text"])
  );
};

const isInspectorMatterTab = (
  value: Record<string, unknown>,
  label: unknown,
) => {
  const color = value["color"];
  return (
    typeof label === "string" &&
    typeof value["workspaceId"] === "string" &&
    (color === undefined || color === null || typeof color === "string")
  );
};

const isInspectorSkillResourceTab = (
  value: Record<string, unknown>,
  label: unknown,
) => {
  const target = value["target"];
  return (
    typeof label === "string" &&
    typeof value["skillName"] === "string" &&
    isOptionalString(value["skillDisplayName"]) &&
    parseSkillResourceSource(value["skillId"], value["origin"]) !== undefined &&
    (target === undefined || target === "body" || target === "resource") &&
    typeof value["resourcePath"] === "string" &&
    typeof value["mimeType"] === "string" &&
    typeof value["content"] === "string"
  );
};

const isInspectorPdfTab = (value: Record<string, unknown>, label: unknown) => {
  const pdfFileId = value["pdfFileId"];
  return (
    typeof label === "string" &&
    typeof value["fileName"] === "string" &&
    typeof value["entityId"] === "string" &&
    typeof value["workspaceId"] === "string" &&
    (pdfFileId === null || typeof pdfFileId === "string") &&
    isOptionalString(value["renderId"]) &&
    isOptionalString(value["mimeType"]) &&
    isOptionalString(value["justificationFieldId"]) &&
    isOptionalString(value["propertyId"]) &&
    isMetadataLane(value["metadataLane"]) &&
    isFileFacet(value["facet"]) &&
    isOptionalNumber(value["facetPulseSeq"])
  );
};

const isInspectorViewTab = (
  value: Record<string, unknown>,
  type: string,
  label: unknown,
) => {
  if (type !== "view" || typeof label !== "string") {
    return false;
  }
  const viewType = value["viewType"];
  if (
    typeof viewType !== "string" ||
    !isOptionalString(value["ownerRouteId"])
  ) {
    return false;
  }
  return (
    getInspectorView(viewType)?.validate(value["payload"]) ??
    getInspectorPersistenceReference(viewType)?.validate(value["payload"]) ??
    false
  );
};

const isInspectorBroadcastMessage = (
  value: unknown,
): value is InspectorBroadcastMessage => {
  if (!isRecord(value)) {
    return false;
  }
  const type = value["type"];
  const senderId = value["senderId"];
  if (typeof type !== "string" || typeof senderId !== "string") {
    return false;
  }
  if (type === "inspector-tabs:request") {
    return true;
  }
  if (type !== "inspector-tabs:sync") {
    return false;
  }
  const tabs = value["tabs"];
  const groups = value["groups"];
  const groupAssignments = value["groupAssignments"];
  return (
    isOptionalString(value["recipientId"]) &&
    typeof value["updatedAt"] === "number" &&
    Array.isArray(tabs) &&
    tabs.every(isInspectorTab) &&
    (groups === undefined ||
      (Array.isArray(groups) && groups.every(isInspectorTabGroup))) &&
    (groupAssignments === undefined || isGroupAssignments(groupAssignments))
  );
};

const normalizeInspectorBroadcastTab = (
  tab: InspectorBroadcastTab,
): InspectorTab => {
  if (tab.type === "task" && tab.creationStatus === undefined) {
    return { ...tab, creationStatus: "ready" };
  }
  if (tab.type === "chat" && "activeDecisionId" in tab) {
    const { activeDecisionId, ...chat } = tab;
    // A tab carrying both was written by a newer client: its key wins.
    return chat.activeLegalKey === undefined
      ? { ...chat, activeLegalKey: decisionChatKey(activeDecisionId) }
      : chat;
  }
  return tab;
};

type PersistedInspectorState = {
  tabs: InspectorBroadcastTab[];
  groups: InspectorTabGroup[];
  groupAssignments: Record<string, string | null>;
  activeId: string | null;
  collapsedGroupIds: string[];
};

const toPersistedInspectorTab = (tab: InspectorTab): InspectorTab | null => {
  // A document's chat that never got a message is not worth a reload: the
  // document finds its conversation on the server when it opens.
  if (
    tab.type === "chat" &&
    tab.activeLegalKey !== undefined &&
    tab.started !== true
  ) {
    return null;
  }
  if (tab.type === "skill-resource") {
    return null;
  }
  if (tab.type === "task" && tab.creationStatus === "pending") {
    return null;
  }
  if (tab.type === "external") {
    const { snippet: _snippet, text: _text, ...reference } = tab;
    return reference;
  }
  if (tab.type === "view") {
    // A route-owned tab belongs to the page that seeded it; restored on a
    // reload that lands elsewhere, it would describe a page nobody opened.
    if (tab.ownerRouteId !== undefined) {
      return null;
    }
    const persistence = getInspectorPersistenceReference(tab.viewType);
    if (persistence === undefined || !persistence.validate(tab.payload)) {
      return null;
    }
    return { ...tab, payload: persistence.project(tab.payload) };
  }
  if (tab.type === "pdf") {
    // The lane binds the tab to the document route this window renders; a
    // reload may land anywhere, and an expanded tab without its route hides
    // the file behind a metadata-only persona.
    const { metadataLane: _metadataLane, ...reference } = tab;
    return reference;
  }
  return tab;
};

const readPersistedInspectorState = (
  scope: InspectorBroadcastScope,
): PersistedInspectorState | null => {
  const empty = {
    tabs: [],
    groups: [],
    groupAssignments: {},
    activeId: null,
    collapsedGroupIds: [],
  };
  const value = readPersistedState(inspectorStateEntry, scope);
  if (value === null) {
    return null;
  }
  const tabs = value.tabs;
  const groups = value.groups;
  const groupAssignments = value.groupAssignments;
  const activeId = value.activeId;
  const collapsedGroupIds = value.collapsedGroupIds;
  if (
    !Array.isArray(tabs) ||
    !Array.isArray(groups) ||
    !groups.every(isInspectorTabGroup) ||
    !isGroupAssignments(groupAssignments) ||
    (activeId !== null && typeof activeId !== "string") ||
    !isStringArray(collapsedGroupIds)
  ) {
    return empty;
  }
  const safeTabs = tabs
    .filter(isInspectorTab)
    .map(normalizeInspectorBroadcastTab)
    .map(toPersistedInspectorTab)
    .filter((tab): tab is InspectorTab => tab !== null);
  const safeTabIds = new Set(safeTabs.map((tab) => tab.id));
  return {
    tabs: safeTabs,
    groups,
    groupAssignments: normalizeInspectorGroupAssignments(
      safeTabs,
      groups,
      groupAssignments,
    ),
    activeId: activeId !== null && safeTabIds.has(activeId) ? activeId : null,
    collapsedGroupIds,
  };
};

const writePersistedInspectorState = (
  scope: InspectorBroadcastScope,
  state: InspectorTabsStore,
): void => {
  if (typeof window === "undefined") {
    return;
  }
  const tabs = state.tabs
    .map(toPersistedInspectorTab)
    .filter((tab): tab is InspectorTab => tab !== null);
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const groupAssignments = Object.fromEntries(
    Object.entries(state.groupAssignments).filter(([tabId]) =>
      tabIds.has(tabId),
    ),
  );
  const storageKey = `${scope.organizationId}:${scope.userId}`;
  const writeResult = writePersistedState(inspectorStateEntry, scope, {
    tabs,
    groups: state.groups,
    groupAssignments,
    activeId: tabIds.has(state.activeId ?? "") ? state.activeId : null,
    collapsedGroupIds: state.collapsedGroupIds,
  });
  if (Result.isOk(writeResult)) {
    if (failedPersistenceScope === storageKey) {
      failedPersistenceScope = null;
    }
    return;
  }
  if (failedPersistenceScope === storageKey) {
    return;
  }
  failedPersistenceScope = storageKey;
  persistenceFailureOccurrence += 1;
  notifyUserError(
    writeResult.error,
    getTranslator()("inspector.groups.saveFailed"),
    { occurrence: persistenceFailureOccurrence },
  );
};

const subscribeInspectorPersistence = (
  store: StoreApi<InspectorTabsStore>,
  scope: InspectorBroadcastScope,
) => {
  const owner = storageOwner();
  const unsubscribeState = store.subscribe((state, previousState) => {
    if (!isCurrentStorageOwner(owner)) {
      return;
    }
    if (
      state.tabs !== previousState.tabs ||
      state.groups !== previousState.groups ||
      state.groupAssignments !== previousState.groupAssignments ||
      state.activeId !== previousState.activeId ||
      state.collapsedGroupIds !== previousState.collapsedGroupIds
    ) {
      writePersistedInspectorState(scope, state);
    }
  });
  const unsubscribeMinimized = store.subscribe((state, previousState) => {
    if (!isCurrentStorageOwner(owner)) {
      return;
    }
    if (state.minimized !== previousState.minimized) {
      writePersistedMinimized(scope, state.minimized);
    }
  });
  return () => {
    unsubscribeState();
    unsubscribeMinimized();
  };
};

export const createInspectorBroadcastSession = (
  store: StoreApi<InspectorTabsStore>,
  scope: InspectorBroadcastScope,
): InspectorBroadcastSession => {
  const owner = storageOwner();
  const channel = new window.BroadcastChannel(
    getInspectorTabsBroadcastChannelName(scope),
  );
  const clientId = createUuid();
  let consumers = 1;
  let applyingRemote = false;
  let lastTabsClock: InspectorBroadcastClock | null = null;

  const postTabs = (recipientId?: string) => {
    if (!isCurrentStorageOwner(owner)) {
      return;
    }
    const state = store.getState();
    const tabs = state.tabs.filter((tab) => !isGenericInspectorTab(tab));
    if (
      recipientId !== undefined &&
      tabs.length === 0 &&
      state.groups.length === 0
    ) {
      return;
    }
    const clock = lastTabsClock ?? { senderId: clientId, updatedAt: 0 };
    try {
      postInspectorBroadcastMessage(channel, {
        type: "inspector-tabs:sync",
        senderId: clientId,
        recipientId,
        updatedAt: clock.updatedAt,
        tabs,
        groups: state.groups,
        groupAssignments: state.groupAssignments,
      });
    } catch (error) {
      getAnalytics().captureError(error, {
        type: "detached",
        operation: "inspector-tabs.broadcast",
      });
    }
  };

  const unsubscribe = store.subscribe((state, previousState) => {
    if (
      applyingRemote ||
      (state.tabs === previousState.tabs &&
        state.groups === previousState.groups &&
        state.groupAssignments === previousState.groupAssignments)
    ) {
      return;
    }
    lastTabsClock = getNextInspectorBroadcastClock(lastTabsClock, clientId);
    postTabs();
  });
  const unsubscribePersistence = subscribeInspectorPersistence(store, scope);

  const handleMessage = (event: MessageEvent<unknown>) => {
    if (!isCurrentStorageOwner(owner)) {
      return;
    }
    const message = event.data;
    if (
      !isInspectorBroadcastMessage(message) ||
      message.senderId === clientId
    ) {
      return;
    }
    if (message.type === "inspector-tabs:request") {
      postTabs(message.senderId);
      return;
    }
    if (message.recipientId !== undefined && message.recipientId !== clientId) {
      return;
    }
    const messageClock = {
      senderId: message.senderId,
      updatedAt: message.updatedAt,
    };
    if (
      lastTabsClock !== null &&
      compareInspectorBroadcastClocks(messageClock, lastTabsClock) <= 0
    ) {
      return;
    }
    applyingRemote = true;
    try {
      lastTabsClock = messageClock;
      const state = store.getState();
      applySharedInspectorTabs(
        store,
        message.tabs.map(normalizeInspectorBroadcastTab),
        message.groups ?? state.groups,
        message.groupAssignments ?? state.groupAssignments,
      );
      writePersistedInspectorState(scope, store.getState());
    } finally {
      applyingRemote = false;
    }
  };
  channel.addEventListener("message", handleMessage);
  postInspectorBroadcastMessage(channel, {
    type: "inspector-tabs:request",
    senderId: clientId,
  });

  const scopeKey = `${scope.organizationId}:${scope.userId}`;
  const dispose = () => {
    unsubscribe();
    unsubscribePersistence();
    channel.removeEventListener("message", handleMessage);
    channel.close();
    if (inspectorBroadcastSession?.scopeKey === scopeKey) {
      inspectorBroadcastSession = null;
    }
  };
  return {
    scopeKey,
    dispose,
    retain: () => {
      consumers += 1;
    },
    release: () => {
      consumers -= 1;
      if (consumers <= 0) {
        dispose();
      }
    },
  };
};

const initializeInspectorScope = (
  store: StoreApi<InspectorTabsStore>,
  scope: InspectorBroadcastScope,
) => {
  const scopeKey = `${scope.organizationId}:${scope.userId}`;
  const previousScopeKey = pageLoad.scopeOwnership.get(store);
  const switchingScope =
    previousScopeKey !== undefined && previousScopeKey !== scopeKey;
  if (
    inspectorBroadcastSession !== null &&
    inspectorBroadcastSession.scopeKey !== scopeKey
  ) {
    inspectorBroadcastSession.dispose();
  }
  pageLoad.scopeOwnership.set(store, scopeKey);
  const persistedMinimized = readPersistedMinimized(scope);
  // The previous restore never settled: keep the pane closed this time.
  const recovering = readRestorePending(scope);
  const minimized = persistedMinimized || recovering;
  if (store.getState().minimized !== minimized) {
    store.setState({ minimized });
  }
  if (inspectorBroadcastSession?.scopeKey !== scopeKey) {
    const persisted = readPersistedInspectorState(scope);
    // Nothing to restore: a flag left by an earlier start has nothing to
    // guard any more.
    if (persisted === null && recovering) {
      writeRestorePending(scope, false);
    }
    if (persisted !== null) {
      const tabs = persisted.tabs.map(normalizeInspectorBroadcastTab);
      if (recovering) {
        getAnalytics().captureInspectorRestoreRecovered({
          tabCount: tabs.length,
        });
      }
      if (!minimized && tabs.length > 0) {
        writeRestorePending(scope, true);
        clearRestorePendingWhenSettled(scope);
      } else if (recovering) {
        writeRestorePending(scope, false);
      }
      adoptRestoredLegalDocumentChatThreads(legalDocumentChatThreadsIn(tabs));
      store.setState({
        tabs,
        groups: persisted.groups,
        groupAssignments: persisted.groupAssignments,
        collapsedGroupIds: persisted.collapsedGroupIds,
        activeId:
          persisted.activeId !== null &&
          tabs.some((tab) => tab.id === persisted.activeId)
            ? persisted.activeId
            : (tabs.at(0)?.id ?? null),
        reviveSuggestion: null,
      });
    } else if (switchingScope) {
      store.setState({
        tabs: [],
        groups: [],
        groupAssignments: {},
        collapsedGroupIds: [],
        activeId: null,
        reviveSuggestion: null,
      });
    }
  }
  if (
    typeof window === "undefined" ||
    typeof window.BroadcastChannel !== "function"
  ) {
    if (typeof window === "undefined") {
      return noopInspectorBroadcastCleanup;
    }
    return subscribeInspectorPersistence(store, scope);
  }
  if (inspectorBroadcastSession?.scopeKey === scopeKey) {
    inspectorBroadcastSession.retain();
    return inspectorBroadcastSession.release;
  }
  inspectorBroadcastSession = createInspectorBroadcastSession(store, scope);
  return inspectorBroadcastSession.release;
};

export const initializeInspectorTabBroadcast = (
  store: StoreApi<InspectorTabsStore>,
  scope: InspectorBroadcastScope,
) => {
  let disconnect = initializeInspectorScope(store, scope);
  const unsubscribeOwner = onStorageOwnerChange(() => {
    disconnect();
    disconnect = noopInspectorBroadcastCleanup;
    pageLoad.scopeOwnership.delete(store);
    store.setState({
      tabs: [],
      groups: [],
      groupAssignments: {},
      collapsedGroupIds: [],
      activeId: null,
      reviveSuggestion: null,
      minimized: false,
    });
    const owner = storageOwner();
    if (owner.kind === "user" && owner.userId === scope.userId) {
      disconnect = initializeInspectorScope(store, scope);
    }
  });
  return () => {
    unsubscribeOwner();
    disconnect();
    disconnect = noopInspectorBroadcastCleanup;
  };
};
