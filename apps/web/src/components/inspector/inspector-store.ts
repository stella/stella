import { v7 as uuidv7 } from "uuid";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import {
  getInspectorView,
  type StructuredCloneable,
} from "@/components/inspector/view-registry";
import type { ChatThreadId } from "@/lib/chat-thread-ref";
import { createChatThreadId } from "@/lib/chat-thread-ref";

export type ExternalTabId = `external:${string}`;

export type FileTab = {
  type: "pdf";
  id: string;
  renderId?: string | undefined;
  entityId: string;
  /** The PDF filename; preserved across justification slot
   *  navigation so the tab header always shows the file name. */
  label: string;
  mimeType?: string | undefined;
  pdfFileId: string | null;
  /** The workspace this tab belongs to. Used to prevent
   *  cross-workspace state leaks in the chat panel. */
  workspaceId: string;
  /** When set, the inspector shows the justification for
   *  this field alongside the PDF viewer. */
  justificationFieldId?: string | undefined;
  /** The property column that was clicked (for showing
   *  the active cell highlight in the PDF). */
  propertyId?: string | undefined;
  /** File-coupled info lane. `expanded` is used when the file
   *  itself is already centered in the main view, so the inspector
   *  tab can dedicate its content to file affordance cards. */
  metadataLane?: "closed" | "expanded" | undefined;
  /**
   * Active sub-view inside the tab. The inspector tab is a facet
   * workbench: file preview, metadata fields, version history,
   * and AI suggestions for the document live as switchable
   * sub-views. Default behaviour:
   *   - sidepeek mode (`metadataLane !== "expanded"`): defaults to
   *     `"preview"` on first render so the user lands on the PDF/
   *     DOCX they just opened.
   *   - fullscreen mode (`metadataLane === "expanded"`): defaults
   *     to `"metadata"` because the main view is already the
   *     preview; `"preview"` is hidden from the facet bar there.
   * Auto-flips to `"suggestions"` when the AI queues edits;
   * remembered across switches so the user keeps their place.
   */
  facet?:
    | "preview"
    | "metadata"
    | "versions"
    | "suggestions"
    | "anonymization"
    | undefined;
  /**
   * Monotonic counter bumped whenever the facet auto-switches
   * (e.g. AI queued new suggestions). The facet bar reads this to
   * play a one-shot teaching pulse on the active chip so the user
   * learns where the new content landed.
   */
  facetPulseSeq?: number | undefined;
};

export type TaskTab = {
  type: "task";
  id: string;
  label: string;
  isNew: boolean;
  status?: string | null;
  /**
   * Owning workspace for the underlying task. Preserved on the tab
   * so the detail panel keeps querying the original matter even
   * when the user navigates to a different workspace before
   * closing the tab.
   */
  workspaceId: string;
};

export type ChatTab = {
  type: "chat";
  id: ChatThreadId;
  label: string;
  /**
   * Owning workspace for the underlying chat thread. `undefined`
   * means the thread is *global* — same UI shell, no matter
   * binding on the thread itself. Distinct from
   * `contextMatterIds` (the AI's draw-from set, which can list
   * matters even when the thread is global). Drives the
   * threadRef scope ChatTabPanel resolves, so the same threadId
   * moves cleanly between the standalone `/chat` surface and the
   * inspector tab.
   */
  workspaceId?: string | undefined;
  /**
   * Workspaces this chat draws context from. Defaults to the
   * matter the chat was opened in; users can extend it via the
   * matter picker in the tab header so the AI sees content from
   * additional matters. Persisted server-side on the chat thread.
   */
  contextMatterIds: string[];
  /**
   * Case-law decision the chat was opened *about*. Mirrors the
   * legacy right-panel-chat behaviour where navigating to a
   * decision auto-grounded a fresh chat in that decision's text.
   * Persists on the tab so subsequent renders keep flowing the
   * decision context into the system prompt regardless of the
   * user's current route.
   */
  activeDecisionId?: string | undefined;
};

export type MatterTabId = `matter:${string}`;

export type MatterTab = {
  type: "matter";
  id: MatterTabId;
  label: string;
  workspaceId: string;
  color?: string | null | undefined;
};

export type ExternalTab = {
  type: "external";
  id: ExternalTabId;
  chatThreadId: ChatThreadId;
  label: string;
  url: string;
  connectorSlug?: string | undefined;
  iconHref?: string | undefined;
  provider?: string | undefined;
  snippet?: string | undefined;
  sourceToolName?: string | undefined;
  text?: string | undefined;
};

export type SkillResourceTabId = `skill-resource:${string}`;

export type SkillResourceTab = {
  type: "skill-resource";
  id: SkillResourceTabId;
  /** Display label — typically the resource filename. */
  label: string;
  /** Slug of the skill (matches load-skill's skillName). */
  skillName: string;
  /** DB row id when the skill is installed; `null` for built-in
   *  skills that live on disk and have no row to mutate. Drives
   *  whether the inspector panel can render the edit affordance. */
  skillId: string | null;
  /** Resource source — built-in skills are immutable, the others
   *  can be edited in place. */
  origin: "built-in" | "upload" | "url";
  /** Path inside the skill bundle (e.g. references/edpb-criteria.md). */
  resourcePath: string;
  /** MIME type from the read-skill-resource tool output. */
  mimeType: string;
  /** Raw text content from the tool output. For binary types
   *  (e.g. application/pdf), the content is a base64 string when
   *  the backend later supports it; today it's always text. */
  content: string;
};

export const buildSkillResourceTabId = ({
  skillName,
  resourcePath,
}: {
  skillName: string;
  resourcePath: string;
}): SkillResourceTabId => `skill-resource:${skillName}/${resourcePath}`;

/**
 * Open-ended inspector tab kind backed by the view registry. Routes
 * outside the workspace inspector register their own renderer +
 * rail icon for a `viewType` and open tabs via `openView`. The
 * concrete payload shape is the registration's responsibility;
 * the store stays payload-agnostic.
 *
 * The `type: "view"` discriminator pairs with the built-in literal
 * types (`"pdf"`, `"chat"`, …) so a discriminated-union narrow on
 * `tab.type` cleanly separates registry-backed tabs from built-in
 * ones. The registered kind itself lives in `viewType`.
 */
export type GenericTab = {
  type: "view";
  viewType: string;
  id: string;
  label: string;
  payload: unknown;
  /**
   * Optional route id that "owns" this tab. Used together with the
   * registration's `navigationPolicy` to auto-close route-bound
   * tabs (e.g. a knowledge-catalogue detail) when the user leaves
   * the route the tab was opened from.
   */
  ownerRouteId?: string | undefined;
};

export type InspectorTab =
  | FileTab
  | TaskTab
  | ChatTab
  | MatterTab
  | ExternalTab
  | SkillResourceTab
  | GenericTab;

export const isGenericInspectorTab = (tab: InspectorTab): tab is GenericTab =>
  tab.type === "view";

type State = {
  tabs: InspectorTab[];
  activeId: string | null;
  /** Increments on every activation; lets the UI flash
   *  a tab that is re-selected (e.g., open same file). */
  activationSeq: number;
  /**
   * One-shot rename request. Set by the rail's right-click menu;
   * the active tab's ribbon reads it, enters edit mode, and clears
   * it. Decouples the rail (which doesn't render the editable
   * label) from the ribbon (which does).
   */
  pendingRenameTabId: string | null;
  /**
   * Collapsed view — the inspector pane is hidden but its tabs
   * are kept. The right-side toggle in the workspace chrome flips
   * this so users can reclaim screen space without losing their
   * open tabs.
   */
  minimized: boolean;
  /**
   * One-shot scroll target for the active DOCX folio editor. Set
   * by `openCitation` when a citation chip is clicked; the editor
   * reads it on mount/update, calls `scrollToBlock`, and clears it
   * via `clearPendingBlockScroll`. Decouples the click handler
   * from the editor lifecycle (the editor may not be mounted yet
   * if the user just opened the file via the citation).
   */
  pendingBlockScroll: { tabId: string; blockId: string } | null;
  /**
   * One-shot edit-mode request for a DOCX tab. Set by callers that
   * open a DOCX file and want the user to land directly in the
   * folio editor (e.g. the chat's "Open in editor" affordance).
   * The inspector panel reads this on tab mount, kicks off
   * `handleStartDocxEdit`, and clears it.
   */
  pendingDocxEditTabId: string | null;
};

type Actions = {
  openFile: (tab: Omit<FileTab, "type">) => void;
  /**
   * Open or update the inspector tab pinned to a given entity. If a
   * FileTab for this entity already exists, its `id` (the file
   * field) and content fields are swapped in place — the user sees
   * one continuous tab even when paging through the file's
   * versions. If no such tab exists, behaves like `openFile` and
   * creates one. The canonical entrypoint for "show this file in
   * the inspector"; routes that surface different versions of the
   * same file (the document route, the version facet) call this so
   * version switches don't multiply tabs.
   */
  openFileForEntity: (tab: Omit<FileTab, "type">) => void;
  openTask: (args: {
    taskId: string;
    workspaceId: string;
    label?: string;
    isNew?: boolean;
  }) => void;
  openExternal: (args: {
    url: string;
    connectorSlug?: string | undefined;
    iconHref?: string | undefined;
    label?: string | undefined;
    provider?: string | undefined;
    snippet?: string | undefined;
    sourceToolName?: string | undefined;
    text?: string | undefined;
  }) => void;
  openMatter: (args: {
    workspaceId: string;
    label: string;
    color?: string | null | undefined;
  }) => void;
  openSkillResourceTab: (
    tab: Omit<SkillResourceTab, "type" | "id"> & {
      skillName: string;
      resourcePath: string;
    },
  ) => void;
  /**
   * Replace the `content` of an open skill-resource tab. Called
   * after a successful save so the panel reflects the new text
   * without refetching from the tool history.
   */
  updateSkillResourceTabContent: (
    tabId: SkillResourceTabId,
    content: string,
  ) => void;
  /**
   * Open a chat tab. Without args, creates a new (local-only) chat
   * with a generated id. Pass `id` + optional `threadId` to restore
   * an existing thread; pass `contextMatterIds` to seed the chat's
   * matter context (typically the matter the user opened it in).
   */
  openChat: (args?: {
    id?: ChatThreadId;
    label?: string;
    /**
     * Owning workspace for the thread. Omit for a global tab —
     * same UI, no matter scope on the thread.
     */
    workspaceId?: string | undefined;
    contextMatterIds?: string[];
    activeDecisionId?: string;
  }) => void;
  /**
   * Replace a chat tab's matter context. Used by the matter
   * picker in the tab header so users can extend the AI's view
   * across multiple matters.
   */
  setChatContext: (tabId: string, matterIds: string[]) => void;
  /**
   * Open (or update) a registry-backed view. Generic entrypoint
   * for non-workspace routes: pass the registered `type` plus the
   * payload your registration knows how to render. If a tab with
   * the same `id` already exists, its label/payload/ownerRouteId
   * are updated in place and it is activated.
   */
  /**
   * `StructuredCloneable<P>` collapses any non-cloneable leaf
   * (function, symbol, class instance) to an error string in the
   * payload type, so the call fails to compile at the open site
   * with a message pointing at the offending field. Pass plain
   * identifiers + re-derive actions inside the view, or keep
   * mutable handler state in a module-level store.
   */
  openView: <P>(args: {
    type: string;
    id: string;
    label: string;
    payload: StructuredCloneable<P>;
    ownerRouteId?: string;
  }) => void;
  /**
   * Drop every tab whose `ownerRouteId === routeId` and whose
   * registered view kind has `navigationPolicy: "close-on-route-leave"`.
   * Called from the protected layout when the active route changes.
   */
  closeTabsForRoute: (routeId: string) => void;
  closeTab: (id: string) => void;
  /** Close every tab except the one with the given id. */
  closeOthers: (id: string) => void;
  setActive: (id: string) => void;
  closeAll: () => void;
  /** Ask the active tab's ribbon to start renaming. */
  requestRename: (id: string) => void;
  /** Clear the rename flag once the ribbon has consumed it. */
  clearRenameRequest: () => void;
  /** Ask the inspector panel to enter folio edit mode for this DOCX tab on mount. */
  requestDocxEdit: (tabId: string) => void;
  /** Clear the docx-edit flag once the inspector panel has consumed it. */
  clearDocxEditRequest: () => void;
  clearTaskNewFlag: (taskId: string) => void;
  replaceFileFieldId: (
    oldFieldId: string,
    replacement: string | FileFieldReplacement,
  ) => void;
  setFileMetadataLane: (
    tabId: string,
    metadataLane: FileTab["metadataLane"],
  ) => void;
  /**
   * Set the active facet for a fullscreen-bound file tab. Pass
   * `pulse: true` when the change is programmatic (e.g. AI just
   * queued suggestions) so the facet bar plays its teaching pulse;
   * leave it false for plain user clicks.
   */
  setFileFacet: (
    tabId: string,
    facet: NonNullable<FileTab["facet"]>,
    options?: { pulse?: boolean },
  ) => void;
  updateLabel: (tabId: string, label: string) => void;
  updateTaskStatus: (taskId: string, status: string | null) => void;
  /** Set the minimized state directly. */
  setMinimized: (minimized: boolean) => void;
  /** Flip the minimized state (right-side button toggle). */
  toggleMinimized: () => void;
  /** Queue a folio scroll for the active DOCX editor of `tabId`.
   *  Cleared after the editor consumes it. */
  requestBlockScroll: (tabId: string, blockId: string) => void;
  clearPendingBlockScroll: () => void;
};

type FileFieldReplacement = {
  id: string;
  label?: string | undefined;
  mimeType?: string | undefined;
  pdfFileId?: string | null | undefined;
  propertyId?: string | undefined;
};

type InspectorBroadcastScope = {
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
  tabs: InspectorTab[];
};

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
    // Quota / disabled storage — fall through; the in-memory store
    // still drives the UI for the current session.
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

  return left.senderId.localeCompare(right.senderId);
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

export const initializeInspectorTabBroadcast = (
  scope: InspectorBroadcastScope,
) => {
  // Hydrate the per-org-per-user minimized preference once per
  // session boot, even when BroadcastChannel isn't available (SSR,
  // older browsers) so the user still gets their preferred pane
  // state on first paint.
  const persistedMinimized = readPersistedMinimized(scope);
  if (useInspectorStore.getState().minimized !== persistedMinimized) {
    useInspectorStore.setState({ minimized: persistedMinimized });
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
  inspectorBroadcastSession = createInspectorBroadcastSession(scope);
  return inspectorBroadcastSession.release;
};

const createInspectorBroadcastSession = (
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
    // Generic registry-backed tabs (`type === "view"`) are
    // local-only — their payloads can hold callbacks the host route
    // owns, which BroadcastChannel can't structurally clone. The
    // built-in workspace tabs (pdf/task/chat/matter/external/
    // skill-resource) carry plain serialisable payloads and stay
    // cross-tab synced.
    const tabs = useInspectorStore
      .getState()
      .tabs.filter((tab) => tab.type !== "view");

    // Dev-only structured-clone guard: catch any new built-in tab
    // payload that quietly grows a non-serialisable field (function,
    // class instance, DOM node) before BroadcastChannel throws deep
    // inside the postMessage call. No-op in production builds.
    if (import.meta.env.DEV) {
      try {
        structuredClone(tabs);
      } catch {
        // The type-level StructuredCloneable<P> bound makes this
        // unreachable for well-typed callers; this catch is a
        // last-line safety net so a slipped-through value can't
        // throw inside BroadcastChannel.postMessage.
        return;
      }
    }
    if (recipientId !== undefined && tabs.length === 0) {
      return;
    }
    const clock = lastTabsClock ?? { senderId: clientId, updatedAt: 0 };

    postInspectorBroadcastMessage(channel, {
      type: "inspector-tabs:sync",
      senderId: clientId,
      recipientId,
      updatedAt: clock.updatedAt,
      tabs,
    });
  };

  const unsubscribe = useInspectorStore.subscribe((state, previousState) => {
    if (applyingRemote || state.tabs === previousState.tabs) {
      return;
    }

    lastTabsClock = getNextInspectorBroadcastClock(lastTabsClock, clientId);
    postTabs();
  });

  // Persist `minimized` so the user's pane preference survives
  // reloads. Per-org-per-user scope mirrors the broadcast scope
  // (so a paralegal toggling minimize on Org A doesn't carry the
  // bit to Org B). Tabs and `activeId` stay session-local.
  const unsubscribeMinimized = useInspectorStore.subscribe(
    (state, previousState) => {
      if (state.minimized === previousState.minimized) {
        return;
      }
      writePersistedMinimized(scope, state.minimized);
    },
  );

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
      applySharedInspectorTabs(message.tabs);
    } finally {
      applyingRemote = false;
    }
  };
  channel.addEventListener("message", handleMessage);

  postInspectorBroadcastMessage(channel, {
    type: "inspector-tabs:request",
    senderId: clientId,
  });

  const dispose = () => {
    unsubscribe();
    unsubscribeMinimized();
    channel.removeEventListener("message", handleMessage);
    channel.close();
    if (inspectorBroadcastSession?.scopeKey === scopeKey) {
      inspectorBroadcastSession = null;
    }
  };

  const scopeKey = `${scope.organizationId}:${scope.userId}`;
  return {
    scopeKey,
    dispose,
    retain: () => {
      consumers += 1;
    },
    release: () => {
      consumers -= 1;
      if (consumers > 0) {
        return;
      }
      dispose();
    },
  };
};

const applySharedInspectorTabs = (tabs: InspectorTab[]) => {
  const current = useInspectorStore.getState();
  const activeId =
    current.activeId !== null && tabs.some((tab) => tab.id === current.activeId)
      ? current.activeId
      : (tabs.at(0)?.id ?? null);
  const pendingRenameTabId =
    current.pendingRenameTabId !== null &&
    tabs.some((tab) => tab.id === current.pendingRenameTabId)
      ? current.pendingRenameTabId
      : null;
  const pendingBlockScroll =
    current.pendingBlockScroll !== null &&
    tabs.some((tab) => tab.id === current.pendingBlockScroll?.tabId)
      ? current.pendingBlockScroll
      : null;

  useInspectorStore.setState({
    tabs,
    activeId,
    pendingRenameTabId,
    pendingBlockScroll,
    activationSeq:
      activeId === current.activeId
        ? current.activationSeq
        : current.activationSeq + 1,
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const isOptionalNumber = (value: unknown): value is number | undefined =>
  value === undefined || typeof value === "number";

const isPdfFacet = (
  value: unknown,
): value is NonNullable<FileTab["facet"]> | undefined =>
  value === undefined ||
  value === "preview" ||
  value === "metadata" ||
  value === "versions" ||
  value === "suggestions" ||
  value === "anonymization";

const isMetadataLane = (value: unknown): value is FileTab["metadataLane"] =>
  value === undefined || value === "closed" || value === "expanded";

const isInspectorTab = (value: unknown): value is InspectorTab => {
  if (!isRecord(value)) {
    return false;
  }

  const type = value["type"];
  const id = value["id"];
  const label = value["label"];

  if (typeof type !== "string" || typeof id !== "string") {
    return false;
  }

  if (type === "task") {
    const status = value["status"];
    return (
      typeof label === "string" &&
      typeof value["isNew"] === "boolean" &&
      (status === undefined || status === null || typeof status === "string")
    );
  }

  if (type === "chat") {
    return (
      typeof label === "string" &&
      isOptionalString(value["workspaceId"]) &&
      isStringArray(value["contextMatterIds"]) &&
      isOptionalString(value["activeDecisionId"])
    );
  }

  if (type === "external") {
    return (
      typeof label === "string" &&
      typeof value["chatThreadId"] === "string" &&
      typeof value["url"] === "string" &&
      isOptionalString(value["connectorSlug"]) &&
      isOptionalString(value["iconHref"]) &&
      isOptionalString(value["provider"]) &&
      isOptionalString(value["snippet"]) &&
      isOptionalString(value["sourceToolName"]) &&
      isOptionalString(value["text"])
    );
  }

  if (type === "matter") {
    const color = value["color"];
    return (
      typeof label === "string" &&
      typeof value["workspaceId"] === "string" &&
      (color === undefined || color === null || typeof color === "string")
    );
  }

  if (type === "skill-resource") {
    const skillId = value["skillId"];
    const origin = value["origin"];
    return (
      typeof label === "string" &&
      typeof value["skillName"] === "string" &&
      (skillId === null || typeof skillId === "string") &&
      (origin === "built-in" || origin === "upload" || origin === "url") &&
      typeof value["resourcePath"] === "string" &&
      typeof value["mimeType"] === "string" &&
      typeof value["content"] === "string"
    );
  }

  if (type === "pdf") {
    const pdfFileId = value["pdfFileId"];
    return (
      typeof label === "string" &&
      typeof value["entityId"] === "string" &&
      typeof value["workspaceId"] === "string" &&
      (pdfFileId === null || typeof pdfFileId === "string") &&
      isOptionalString(value["renderId"]) &&
      isOptionalString(value["mimeType"]) &&
      isOptionalString(value["justificationFieldId"]) &&
      isOptionalString(value["propertyId"]) &&
      isMetadataLane(value["metadataLane"]) &&
      isPdfFacet(value["facet"]) &&
      isOptionalNumber(value["facetPulseSeq"])
    );
  }

  // Registry-backed view tab. Without this hop, cross-tab
  // BroadcastChannel sync would silently filter out tabs whose
  // kind was registered by a route that's only loaded in one of
  // the open browser tabs.
  if (type !== "view") {
    return false;
  }
  const viewType = value["viewType"];
  if (typeof viewType !== "string") {
    return false;
  }
  if (typeof label !== "string") {
    return false;
  }
  if (!isOptionalString(value["ownerRouteId"])) {
    return false;
  }
  const registration = getInspectorView(viewType);
  if (registration === undefined) {
    return false;
  }
  if (registration.validate === undefined) {
    return true;
  }
  return registration.validate(value["payload"]);
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

export const useInspectorStore = create<State & Actions>()(
  immer((set) => ({
    tabs: [],
    activeId: null,
    activationSeq: 0,
    pendingRenameTabId: null,
    minimized: false,
    pendingBlockScroll: null,
    pendingDocxEditTabId: null,

    openFile: (tab) =>
      set((state) => {
        // One inspector tab per file. Match by entity (canonical:
        // any version of the same file) or by id (e.g. a tab the
        // caller already knows). When a match is found we update
        // it in place and drop any other pdf tab that would now
        // collide on entityId or id, so the tab list never holds
        // duplicates that would alias to the same React key.
        const matchIndex = state.tabs.findIndex(
          (t) =>
            t.type === "pdf" &&
            (t.entityId === tab.entityId || t.id === tab.id),
        );
        if (matchIndex === -1) {
          state.tabs.push({ type: "pdf", renderId: uuidv7(), ...tab });
        } else {
          const existing = state.tabs[matchIndex];
          if (existing && existing.type === "pdf") {
            const previousId = existing.id;
            const idChanged = previousId !== tab.id;
            existing.id = tab.id;
            existing.entityId = tab.entityId;
            existing.workspaceId = tab.workspaceId;
            existing.justificationFieldId = tab.justificationFieldId;
            existing.propertyId = tab.propertyId;
            existing.metadataLane = tab.metadataLane;
            if (tab.label) {
              existing.label = tab.label;
            }
            if (tab.mimeType !== undefined) {
              existing.mimeType = tab.mimeType;
            }
            existing.pdfFileId = tab.pdfFileId;
            // Bump the render id only when the underlying field
            // changed (version switch); a no-op re-open of the same
            // field shouldn't remount the viewer subtree.
            if (idChanged) {
              existing.renderId = uuidv7();
            }
            state.tabs = state.tabs.filter(
              (t, i) =>
                i === matchIndex ||
                !(
                  t.type === "pdf" &&
                  (t.entityId === tab.entityId || t.id === tab.id)
                ),
            );
            if (state.activeId === previousId) {
              state.activeId = tab.id;
            }
          }
        }
        state.activeId = tab.id;
        state.activationSeq += 1;
        // Opening a tab while the inspector is collapsed should
        // bring it back into view; otherwise the user's click
        // appears to do nothing.
        state.minimized = false;
      }),

    openFileForEntity: (tab) =>
      set((state) => {
        // Same single-tab-per-file invariant as openFile, but
        // entity-first: callers (versions facet) hand us a fieldId
        // for a different version of the same file and expect the
        // existing tab to swap in place. Always bumps renderId so
        // the viewer subtree picks up the new buffer.
        const matchIndex = state.tabs.findIndex(
          (t) =>
            t.type === "pdf" &&
            (t.entityId === tab.entityId || t.id === tab.id),
        );
        if (matchIndex === -1) {
          state.tabs.push({ type: "pdf", renderId: uuidv7(), ...tab });
          state.activeId = tab.id;
        } else {
          const existing = state.tabs[matchIndex];
          if (existing && existing.type === "pdf") {
            const previousId = existing.id;
            existing.id = tab.id;
            existing.entityId = tab.entityId;
            existing.workspaceId = tab.workspaceId;
            existing.justificationFieldId = tab.justificationFieldId;
            existing.propertyId = tab.propertyId;
            existing.metadataLane = tab.metadataLane;
            if (tab.label) {
              existing.label = tab.label;
            }
            if (tab.mimeType !== undefined) {
              existing.mimeType = tab.mimeType;
            }
            existing.pdfFileId = tab.pdfFileId;
            existing.renderId = uuidv7();
            state.tabs = state.tabs.filter(
              (t, i) =>
                i === matchIndex ||
                !(
                  t.type === "pdf" &&
                  (t.entityId === tab.entityId || t.id === tab.id)
                ),
            );
            if (state.activeId === previousId) {
              state.activeId = tab.id;
            }
          }
        }
        state.activationSeq += 1;
        state.minimized = false;
      }),

    openTask: ({ taskId, workspaceId, label = "", isNew = false }) =>
      set((state) => {
        const existing = state.tabs.find((t) => t.id === taskId);
        if (!existing) {
          state.tabs.push({
            type: "task",
            id: taskId,
            label,
            isNew,
            workspaceId,
          });
        } else if (existing.type === "task") {
          if (label) {
            existing.label = label;
          }
          if (isNew) {
            existing.isNew = true;
          }
          existing.workspaceId = workspaceId;
        }
        state.activeId = taskId;
        state.activationSeq += 1;
        state.minimized = false;
      }),

    openExternal: ({
      connectorSlug,
      iconHref,
      label,
      provider,
      snippet,
      sourceToolName,
      text,
      url,
    }) =>
      set((state) => {
        const id: ExternalTabId = `external:${url}`;
        let fallbackLabel = url;
        try {
          fallbackLabel = new URL(url).hostname;
        } catch {
          // Keep the raw URL as a last-resort tab label.
        }
        const existing = state.tabs.find((t) => t.id === id);
        if (!existing) {
          state.tabs.push({
            type: "external",
            id,
            chatThreadId: createChatThreadId(),
            label: label ?? fallbackLabel,
            connectorSlug,
            iconHref,
            provider,
            snippet,
            sourceToolName,
            text,
            url,
          });
        } else if (existing.type === "external") {
          existing.label = label ?? existing.label;
          existing.connectorSlug = connectorSlug ?? existing.connectorSlug;
          existing.iconHref = iconHref ?? existing.iconHref;
          existing.provider = provider ?? existing.provider;
          existing.snippet = snippet ?? existing.snippet;
          existing.sourceToolName = sourceToolName ?? existing.sourceToolName;
          existing.text = text ?? existing.text;
        }
        state.activeId = id;
        state.activationSeq += 1;
        state.minimized = false;
      }),

    openMatter: ({ workspaceId, label, color }) =>
      set((state) => {
        const id: MatterTabId = `matter:${workspaceId}`;
        const existing = state.tabs.find((t) => t.id === id);
        if (!existing) {
          state.tabs.push({
            type: "matter",
            id,
            label,
            workspaceId,
            color,
          });
        } else if (existing.type === "matter") {
          existing.label = label;
          existing.workspaceId = workspaceId;
          existing.color = color;
        }
        state.activeId = id;
        state.activationSeq += 1;
        state.minimized = false;
      }),

    openSkillResourceTab: ({
      skillName,
      skillId,
      origin,
      resourcePath,
      label,
      mimeType,
      content,
    }) =>
      set((state) => {
        const id = buildSkillResourceTabId({ skillName, resourcePath });
        const existing = state.tabs.find((t) => t.id === id);
        if (!existing) {
          state.tabs.push({
            type: "skill-resource",
            id,
            label,
            skillName,
            skillId,
            origin,
            resourcePath,
            mimeType,
            content,
          });
        } else if (existing.type === "skill-resource") {
          const sourceChanged =
            existing.skillId !== skillId || existing.origin !== origin;
          existing.label = label;
          existing.skillName = skillName;
          existing.skillId = skillId;
          existing.origin = origin;
          existing.resourcePath = resourcePath;
          existing.mimeType = mimeType;
          if (sourceChanged) {
            existing.content = content;
          }
        }
        state.activeId = id;
        state.activationSeq += 1;
        state.minimized = false;
      }),

    updateSkillResourceTabContent: (tabId, content) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (tab && tab.type === "skill-resource") {
          tab.content = content;
        }
      }),

    openChat: (args = {}) =>
      set((state) => {
        const id = args.id ?? createChatThreadId();
        const existing = state.tabs.find((t) => t.id === id);
        if (!existing) {
          state.tabs.push({
            type: "chat",
            id,
            label: args.label ?? "New chat",
            workspaceId: args.workspaceId,
            contextMatterIds: args.contextMatterIds ?? [],
            activeDecisionId: args.activeDecisionId,
          });
        } else if (existing.type === "chat") {
          if (args.label !== undefined) {
            existing.label = args.label;
          }
          if (args.workspaceId !== undefined) {
            existing.workspaceId = args.workspaceId;
          }
          if (args.contextMatterIds !== undefined) {
            existing.contextMatterIds = args.contextMatterIds;
          }
          if (args.activeDecisionId !== undefined) {
            existing.activeDecisionId = args.activeDecisionId;
          }
        }
        state.activeId = id;
        state.activationSeq += 1;
        state.minimized = false;
      }),

    setChatContext: (tabId, matterIds) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (tab?.type === "chat") {
          tab.contextMatterIds = matterIds;
        }
      }),

    openView: ({ type, id, label, payload, ownerRouteId }) =>
      set((state) => {
        const existing = state.tabs.find((t) => t.id === id);
        if (!existing) {
          state.tabs.push({
            type: "view",
            viewType: type,
            id,
            label,
            payload,
            ownerRouteId,
          });
        } else if (isGenericInspectorTab(existing)) {
          existing.viewType = type;
          existing.label = label;
          existing.payload = payload;
          existing.ownerRouteId = ownerRouteId;
        }
        state.activeId = id;
        state.activationSeq += 1;
        state.minimized = false;
      }),

    closeTabsForRoute: (routeId) =>
      set((state) => {
        // Only drop tabs whose registered view kind explicitly opts
        // into route-leave teardown. Built-in workspace tabs (PDF,
        // chat, task, …) persist across navigation by design.
        const removed = new Set<string>();
        state.tabs = state.tabs.filter((tab) => {
          if (!isGenericInspectorTab(tab) || tab.ownerRouteId !== routeId) {
            return true;
          }
          const registration = getInspectorView(tab.viewType);
          if (registration?.navigationPolicy !== "close-on-route-leave") {
            return true;
          }
          removed.add(tab.id);
          return false;
        });
        if (removed.size === 0) {
          return;
        }
        if (state.activeId !== null && removed.has(state.activeId)) {
          state.activeId = state.tabs.at(0)?.id ?? null;
        }
      }),

    closeTab: (id) =>
      set((state) => {
        const index = state.tabs.findIndex((t) => t.id === id);
        if (index === -1) {
          return;
        }

        state.tabs.splice(index, 1);

        if (state.activeId === id) {
          const next = state.tabs[Math.min(index, state.tabs.length - 1)];
          state.activeId = next?.id ?? null;
        }
      }),

    closeOthers: (id) =>
      set((state) => {
        const target = state.tabs.find((t) => t.id === id);
        if (!target) {
          return;
        }
        state.tabs = [target];
        state.activeId = id;
      }),

    setActive: (id) =>
      set((state) => {
        state.activeId = id;
        state.activationSeq += 1;
      }),

    requestRename: (id) =>
      set((state) => {
        state.activeId = id;
        state.activationSeq += 1;
        state.pendingRenameTabId = id;
      }),

    clearRenameRequest: () =>
      set((state) => {
        state.pendingRenameTabId = null;
      }),

    requestDocxEdit: (tabId) =>
      set((state) => {
        state.pendingDocxEditTabId = tabId;
      }),

    clearDocxEditRequest: () =>
      set((state) => {
        state.pendingDocxEditTabId = null;
      }),

    closeAll: () =>
      set((state) => {
        state.tabs = [];
        state.activeId = null;
      }),

    clearTaskNewFlag: (taskId) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === taskId);
        if (tab?.type === "task") {
          tab.isNew = false;
        }
      }),

    replaceFileFieldId: (oldFieldId, replacement) =>
      set((state) => {
        const tab = state.tabs.find(
          (t) => t.type === "pdf" && t.id === oldFieldId,
        );
        if (!tab || tab.type !== "pdf") {
          return;
        }

        const next =
          typeof replacement === "string" ? { id: replacement } : replacement;
        // Keep the renamed tab, but drop any stale tab already using the target id.
        state.tabs = state.tabs.filter(
          (t) => t.id === oldFieldId || t.id !== next.id,
        );
        const idChanged = tab.id !== next.id;
        tab.id = next.id;
        if (idChanged) {
          tab.renderId = uuidv7();
        }
        if (tab.justificationFieldId === oldFieldId) {
          tab.justificationFieldId = next.id;
        }
        if (next.label) {
          tab.label = next.label;
        }
        if (next.mimeType !== undefined) {
          tab.mimeType = next.mimeType;
        }
        if (next.pdfFileId !== undefined) {
          tab.pdfFileId = next.pdfFileId;
        }
        if (next.propertyId !== undefined) {
          tab.propertyId = next.propertyId;
        }
        if (state.activeId === oldFieldId) {
          state.activeId = next.id;
        }
      }),

    setFileMetadataLane: (tabId, metadataLane) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (tab?.type === "pdf") {
          tab.metadataLane = metadataLane;
        }
      }),

    setFileFacet: (tabId, facet, options) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (tab?.type !== "pdf") {
          return;
        }
        tab.facet = facet;
        if (options?.pulse) {
          tab.facetPulseSeq = (tab.facetPulseSeq ?? 0) + 1;
          // A programmatic switch (AI queued new suggestions) is
          // also a signal the user should see — un-minimize the
          // inspector so the pulse isn't hidden behind the rail.
          state.minimized = false;
        }
      }),

    updateLabel: (tabId, label) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (tab) {
          tab.label = label;
        }
      }),

    updateTaskStatus: (taskId, status) =>
      set((state) => {
        const tab = state.tabs.find(
          (t) => t.type === "task" && t.id === taskId,
        );
        if (tab && tab.type === "task") {
          tab.status = status;
        }
      }),

    setMinimized: (minimized) =>
      set((state) => {
        state.minimized = minimized;
      }),

    toggleMinimized: () =>
      set((state) => {
        state.minimized = !state.minimized;
      }),

    requestBlockScroll: (tabId, blockId) =>
      set((state) => {
        state.pendingBlockScroll = { tabId, blockId };
      }),

    clearPendingBlockScroll: () =>
      set((state) => {
        state.pendingBlockScroll = null;
      }),
  })),
);
