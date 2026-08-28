import { v7 as uuidv7 } from "uuid";
import type { StoreApi } from "zustand";

import { isTaskStatus } from "@stll/api-contract";

import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import {
  FILE_FACETS,
  type ChatTab,
  type FileTab,
  type InspectorTab,
  type InspectorTabsStore,
  type TaskTab,
} from "@/components/inspector/inspector-store-types";
import {
  isGenericInspectorTab,
  reconcileSharedInspectorTabs,
} from "@/components/inspector/inspector-tabs-slice";
import { getInspectorView } from "@/components/inspector/view-registry";
import { getAnalytics } from "@/lib/analytics/provider";

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
};

type InspectorBroadcastTab =
  | InspectorTab
  | (Omit<TaskTab, "creationStatus"> & { creationStatus?: undefined });

type InspectorBroadcastMessage =
  | InspectorTabsRequestMessage
  | InspectorTabsSyncMessage;

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
const INSPECTOR_MINIMIZED_STORAGE_PREFIX = "stella:inspector-minimized:v1";
const noopInspectorBroadcastCleanup = () => undefined;

const getInspectorMinimizedStorageKey = ({
  userId,
  organizationId,
}: InspectorBroadcastScope) =>
  `${INSPECTOR_MINIMIZED_STORAGE_PREFIX}:${organizationId}:${userId}`;

const readPersistedMinimized = (scope: InspectorBroadcastScope): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return (
      window.localStorage.getItem(getInspectorMinimizedStorageKey(scope)) ===
      "1"
    );
  } catch {
    return false;
  }
};

const writePersistedMinimized = (
  scope: InspectorBroadcastScope,
  minimized: boolean,
): void => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      getInspectorMinimizedStorageKey(scope),
      minimized ? "1" : "0",
    );
  } catch {
    // The in-memory store remains usable when storage is unavailable.
  }
};

let inspectorBroadcastSession: InspectorBroadcastSession | null = null;

/* eslint-disable unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage does not accept targetOrigin. */
const postInspectorBroadcastMessage = (
  channel: BroadcastChannel,
  message: InspectorBroadcastMessage,
) => {
  channel.postMessage(message);
};
/* eslint-enable unicorn/require-post-message-target-origin */

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
  const now = Date.now();
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

const applySharedInspectorTabs = (
  store: StoreApi<InspectorTabsStore>,
  tabs: InspectorTab[],
) => {
  const next = reconcileSharedInspectorTabs(store.getState(), tabs);
  store.setState(next);
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

export const isFileFacet = (
  value: unknown,
): value is NonNullable<FileTab["facet"]> | undefined =>
  value === undefined ||
  (typeof value === "string" && FILE_FACETS.some((facet) => facet === value));

const isMetadataLane = (value: unknown): value is FileTab["metadataLane"] =>
  value === undefined || value === "closed" || value === "expanded";

const isActiveSkillContext = (
  value: unknown,
): value is ChatTab["activeSkill"] => {
  if (value === undefined) {
    return true;
  }
  return (
    isRecord(value) &&
    typeof value["skillName"] === "string" &&
    isOptionalString(value["skillId"])
  );
};

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
    (status === undefined || status === null || isTaskStatus(status))
  );
};

const isInspectorChatTab = (value: Record<string, unknown>, label: unknown) =>
  typeof label === "string" &&
  isOptionalString(value["workspaceId"]) &&
  isStringArray(value["contextMatterIds"]) &&
  isOptionalString(value["activeDecisionId"]) &&
  isActiveSkillContext(value["activeSkill"]);

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
  const skillId = value["skillId"];
  const origin = value["origin"];
  const target = value["target"];
  return (
    typeof label === "string" &&
    typeof value["skillName"] === "string" &&
    (skillId === null || typeof skillId === "string") &&
    (origin === "authored" ||
      origin === "built-in" ||
      origin === "bundled" ||
      origin === "upload" ||
      origin === "url") &&
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
  return getInspectorView(viewType)?.validate(value["payload"]) ?? false;
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
  return (
    isOptionalString(value["recipientId"]) &&
    typeof value["updatedAt"] === "number" &&
    Array.isArray(tabs) &&
    tabs.every(isInspectorTab)
  );
};

const normalizeInspectorBroadcastTab = (
  tab: InspectorBroadcastTab,
): InspectorTab =>
  tab.type === "task" && tab.creationStatus === undefined
    ? { ...tab, creationStatus: "ready" }
    : tab;

const createInspectorBroadcastSession = (
  store: StoreApi<InspectorTabsStore>,
  scope: InspectorBroadcastScope,
): InspectorBroadcastSession => {
  const channel = new window.BroadcastChannel(
    getInspectorTabsBroadcastChannelName(scope),
  );
  const clientId = uuidv7();
  let consumers = 1;
  let applyingRemote = false;
  let lastTabsClock: InspectorBroadcastClock | null = null;

  const postTabs = (recipientId?: string) => {
    const tabs = store
      .getState()
      .tabs.filter((tab) => !isGenericInspectorTab(tab));
    if (recipientId !== undefined && tabs.length === 0) {
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
      });
    } catch (error) {
      getAnalytics().captureError(error, {
        type: "detached",
        operation: "inspector-tabs.broadcast",
      });
    }
  };

  const unsubscribe = store.subscribe((state, previousState) => {
    if (applyingRemote || state.tabs === previousState.tabs) {
      return;
    }
    lastTabsClock = getNextInspectorBroadcastClock(lastTabsClock, clientId);
    postTabs();
  });
  const unsubscribeMinimized = store.subscribe((state, previousState) => {
    if (state.minimized !== previousState.minimized) {
      writePersistedMinimized(scope, state.minimized);
    }
  });

  const handleMessage = (event: MessageEvent<unknown>) => {
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
      applySharedInspectorTabs(
        store,
        message.tabs.map(normalizeInspectorBroadcastTab),
      );
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
    unsubscribeMinimized();
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

export const initializeInspectorTabBroadcast = (
  store: StoreApi<InspectorTabsStore>,
  scope: InspectorBroadcastScope,
) => {
  const persistedMinimized = readPersistedMinimized(scope);
  if (store.getState().minimized !== persistedMinimized) {
    store.setState({ minimized: persistedMinimized });
  }
  if (
    typeof window === "undefined" ||
    typeof window.BroadcastChannel !== "function"
  ) {
    return noopInspectorBroadcastCleanup;
  }
  const scopeKey = `${scope.organizationId}:${scope.userId}`;
  if (inspectorBroadcastSession?.scopeKey === scopeKey) {
    inspectorBroadcastSession.retain();
    return inspectorBroadcastSession.release;
  }
  inspectorBroadcastSession?.dispose();
  inspectorBroadcastSession = createInspectorBroadcastSession(store, scope);
  return inspectorBroadcastSession.release;
};
