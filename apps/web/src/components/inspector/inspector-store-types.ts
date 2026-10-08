import type { RegisteredRouter, RouteIds } from "@tanstack/react-router";
import type { Draft } from "immer";

import type { TaskStatus } from "@stll/api-contract";

import type { ComposerSource } from "@/components/chat-editor-source";
import type { FileTab } from "@/components/inspector/file-tab";
import type { StructuredCloneable } from "@/components/inspector/view-registry";
import type { LegalDocumentChatKey } from "@/features/chat/legal-document-chat-key";
import type { ChatThreadId } from "@/lib/chat-thread-ref";
import type { skillDetailOptions } from "@/lib/knowledge/queries";

export type ExternalTabId = `external:${string}`;

/** The route a page-owned tab belongs to; the tab closes when it leaves. */
export type InspectorOwnerRouteId = RouteIds<RegisteredRouter["routeTree"]>;

export { FILE_FACETS } from "@stll/api-contract/inspector-file-facet";
export type { FileFacet } from "@stll/api-contract/inspector-file-facet";
export type { FileTab } from "@/components/inspector/file-tab";

export type TaskTab = {
  type: "task";
  id: string;
  creationStatus: "pending" | "ready";
  label: string;
  isNew: boolean;
  status?: TaskStatus | null;
  workspaceId: string;
};

export type ChatTab = {
  type: "chat";
  id: ChatThreadId;
  label: string;
  workspaceId?: string | undefined;
  contextMatterIds: string[];
  /** The legal document this chat is about, when it was opened from one. */
  activeLegalKey?: LegalDocumentChatKey | undefined;
  activeSkill?:
    | {
        /** Absent for a built-in skill, which has no row: `skillName` names it. */
        skillId?: string | undefined;
        /** The skill's identifier (its slug), never shown as its title. */
        skillName: string;
        /** The title a person reads (`skillLabel`); absent on older tabs. */
        skillDisplayName?: string | undefined;
      }
    | undefined;
};

export type MatterTabId = `matter:${string}`;

type MatterTab = {
  type: "matter";
  id: MatterTabId;
  label: string;
  workspaceId: string;
  color?: string | null | undefined;
};

type ExternalTab = {
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
  workspaceId: string | null;
};

export type SkillResourceTabId = `skill-resource:${string}`;

export type SkillResourceOrigin = Awaited<
  ReturnType<NonNullable<ReturnType<typeof skillDetailOptions>["queryFn"]>>
>["origin"];

// Keyed by the API's origin union so a new persisted origin fails to compile
// here instead of being rejected at runtime by the tab validators.
const SKILL_RESOURCE_ORIGINS = {
  authored: true,
  bundled: true,
  default: true,
  upload: true,
  url: true,
} as const satisfies Record<SkillResourceOrigin, true>;

const isSkillResourceOrigin = (value: unknown): value is SkillResourceOrigin =>
  typeof value === "string" && Object.hasOwn(SKILL_RESOURCE_ORIGINS, value);

export const BUILT_IN_SKILL_ORIGIN = "built-in";

/**
 * Where a skill resource comes from: a skill row (edited, proposed against and
 * access-checked by its id) or a built-in skill shipped with Stella, which has
 * no row and is read-only.
 */
export type SkillResourceSource =
  | { origin: typeof BUILT_IN_SKILL_ORIGIN; skillId: null }
  | { origin: SkillResourceOrigin; skillId: string };

export const parseSkillResourceSource = (
  skillId: unknown,
  origin: unknown,
): SkillResourceSource | undefined => {
  if (origin === BUILT_IN_SKILL_ORIGIN) {
    return skillId === null ? { origin, skillId } : undefined;
  }
  if (isSkillResourceOrigin(origin) && typeof skillId === "string") {
    return { origin, skillId };
  }
  return undefined;
};

type SkillResourceTabFields = {
  type: "skill-resource";
  id: SkillResourceTabId;
  label: string;
  /** The skill's identifier (its slug), never shown as its title. */
  skillName: string;
  /** The title a person reads (`skillLabel`), when it was known. */
  skillDisplayName?: string | undefined;
  target: "body" | "resource";
  resourcePath: string;
  mimeType: string;
  content: string;
};

export type SkillResourceTab = SkillResourceTabFields & SkillResourceSource;

/** What a skill is called on screen: its title, or its slug if none is known. */
export const skillLabel = ({
  skillDisplayName,
  skillName,
}: {
  skillDisplayName?: string | undefined;
  skillName: string;
}): string => skillDisplayName ?? skillName;

export type InstalledSkillResourceTab = SkillResourceTabFields & {
  origin: SkillResourceOrigin;
  skillId: string;
};

export type GenericTab = {
  type: "view";
  viewType: string;
  id: string;
  label: string;
  payload: unknown;
  ownerRouteId?: InspectorOwnerRouteId | undefined;
};

export type InspectorTab =
  | FileTab
  | TaskTab
  | ChatTab
  | MatterTab
  | ExternalTab
  | SkillResourceTab
  | GenericTab;

export type InspectorTabGroup =
  | { id: string; type: "matter"; workspaceId: string }
  | { id: string; type: "custom"; name: string; color: string };

/** A tab shape `openTabs` can materialize: the kinds a workspace entity maps to. */
export type InspectorOpenTarget = FileTab | TaskTab;

type DocumentTextSelection = {
  text: string;
  seq: number;
};

export type AnonymizationMatchSnapshot = {
  totalMatches: number;
  countByCanonical: Map<string, number>;
  labelByCanonical: Map<string, string>;
};

type AnonymizationSelectionSource = "doc" | "sidebar";

type AnonymizationSelection = {
  canonical: string | null;
  label: string | null;
  source: AnonymizationSelectionSource | null;
  fieldId: string | null;
  seq: number;
};

export type InspectorTabsState = {
  tabs: InspectorTab[];
  groups: InspectorTabGroup[];
  groupAssignments: Record<string, string | null>;
  collapsedGroupIds: string[];
  activeId: string | null;
  activationSeq: number;
  flashTabId: string | null;
  flashSeq: number;
  minimized: boolean;
  reviveSuggestion: InspectorTab | null;
};

type InspectorCommandState = {
  desktopOpenAttention: {
    fieldId: string;
    sequence: number;
  } | null;
  pendingRenameTabId: string | null;
  pendingBlockScroll: {
    tabId: string;
    blockId: string;
    text?: string | undefined;
    /**
     * Identifies THIS request. Monotonic across the store, so asking twice
     * for the same block produces two distinguishable requests: the consumer
     * keys "already handled" on `seq`, which is what makes a repeated
     * "Show in document" on the block the reader is already parked on scroll
     * (and flash) again instead of reading as the request it already served.
     */
    seq: number;
  } | null;
  /** Last issued {@link pendingBlockScroll} sequence. Never reset by a clear,
   *  so a cleared-and-re-requested scroll is never mistaken for the old one. */
  blockScrollSeq: number;
  pendingPdfPageScroll: {
    tabId: string;
    pageNumber: number;
  } | null;
  pendingDocxEditTabId: string | null;
  /** A composer draft handed to the chat over one document (a review
   *  finding to discuss); the overlay for that file consumes it. */
  pendingFileChatDraft: {
    fileFieldId: string;
    /** What the composer takes: prose or its own inline Markdown. */
    markdown: ComposerSource;
    sequence: number;
  } | null;
};

type AnonymizationPipelineStatus = "idle" | "running" | "ready" | "error";

type InspectorAnonymizationState = {
  anonymizationActiveMountCount: number;
  documentTextSelectionByFieldId: Record<string, DocumentTextSelection>;
  anonymizationMatchesByFieldId: Record<string, AnonymizationMatchSnapshot>;
  anonymizationPipelineStatusByFieldId: Record<
    string,
    AnonymizationPipelineStatus
  >;
  anonymizationRetryByFieldId: Record<string, number>;
  anonymizationSelection: AnonymizationSelection;
};

type CloseTabOptions = {
  suggestRevive?: boolean;
};

type FileFieldReplacement = {
  id: string;
  fileName?: string | undefined;
  label?: string | undefined;
  mimeType?: string | undefined;
  pdfFileId?: string | null | undefined;
  propertyId?: string | undefined;
};

/** `activeId` must name one of `targets`; the caller picks the focused tab
 *  because "first in the selection" differs between the table and the tree. */
export type OpenTabsArgs = {
  targets: readonly InspectorOpenTarget[];
  activeId: string;
};

/**
 * What an opener does with the pane. A page that seeds tabs beside its own
 * content passes `keep`, so mounting it never takes the pane from a reader
 * who collapsed it.
 */
export const INSPECTOR_PANE_INTENT = {
  expand: "expand",
  keep: "keep",
} as const;

type InspectorPaneIntent =
  (typeof INSPECTOR_PANE_INTENT)[keyof typeof INSPECTOR_PANE_INTENT];

type InspectorTabsActions = {
  createGroup: (args: { name: string; color: string }) => string;
  updateGroup: (args: { id: string; name: string; color: string }) => void;
  removeGroup: (id: string) => void;
  setTabGroup: (tabId: string, groupId: string | null) => void;
  toggleGroupCollapsed: (id: string) => void;
  expandGroup: (id: string) => void;
  openFile: (tab: Omit<FileTab, "type">) => void;
  openFileForEntity: (tab: Omit<FileTab, "type">) => void;
  openTask: (args: {
    taskId: string;
    workspaceId: string;
    label?: string;
    isNew?: boolean;
  }) => void;
  openPendingTask: (args: { workspaceId: string; label?: string }) => string;
  openTabs: (args: OpenTabsArgs) => void;
  resolvePendingTask: (args: { pendingTaskId: string; taskId: string }) => void;
  openExternal: (args: {
    url: string;
    workspaceId: string | null;
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
    tab: Omit<SkillResourceTabFields, "type" | "id" | "target"> &
      SkillResourceSource & {
        refreshContent?: boolean | undefined;
        target?: SkillResourceTab["target"];
      },
  ) => void;
  updateSkillResourceTabContent: (
    tabId: SkillResourceTabId,
    content: string,
  ) => void;
  openChat: (args?: {
    id?: ChatThreadId;
    label?: string;
    workspaceId?: string | undefined;
    contextMatterIds?: string[];
    activeLegalKey?: LegalDocumentChatKey;
    activeSkill?: ChatTab["activeSkill"];
    pane?: InspectorPaneIntent;
  }) => void;
  setChatContext: (tabId: string, matterIds: string[]) => void;
  resetChatTabId: (oldId: ChatThreadId, newId: ChatThreadId) => void;
  openView: <P>(args: {
    type: string;
    id: string;
    label: string;
    payload: StructuredCloneable<P>;
    ownerRouteId?: InspectorOwnerRouteId;
    pane?: InspectorPaneIntent;
  }) => void;
  updateView: <P>(args: {
    id: string;
    label: string;
    payload: StructuredCloneable<P>;
  }) => void;
  /** Close every route-owned tab whose owner route is not among `routeIds`. */
  closeTabsOutsideRoutes: (routeIds: ReadonlySet<string>) => void;
  closeTab: (id: string, options?: CloseTabOptions) => void;
  closeOthers: (id: string) => void;
  reviveSuggestedTab: () => void;
  clearReviveSuggestion: () => void;
  setActive: (id: string) => void;
  closeAll: () => void;
  clearTaskNewFlag: (taskId: string) => void;
  replaceFileFieldId: (
    oldFieldId: string,
    replacement: string | FileFieldReplacement,
  ) => void;
  setFileMetadataLane: (
    tabId: string,
    metadataLane: FileTab["metadataLane"],
  ) => void;
  setFileFacet: (
    tabId: string,
    facet: NonNullable<FileTab["facet"]>,
    options?: { pulse?: boolean },
  ) => void;
  updateLabel: (tabId: string, label: string) => void;
  updateFileMetadata: (
    tabId: string,
    metadata: Pick<FileTab, "label" | "fileName">,
  ) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus | null) => void;
  /** Asks the tab's rail entry to flash once. The request waits for the
   *  entry to render, so a tab opened in the same update still flashes. */
  flashTab: (tabId: string) => void;
  /** The rail entry flashed; a later remount must not flash it again. */
  clearTabFlash: (tabId: string) => void;
  setMinimized: (minimized: boolean) => void;
  toggleMinimized: () => void;
};

type InspectorCommandActions = {
  requestDesktopOpenAttention: (fieldId: string) => void;
  clearDesktopOpenAttention: (sequence: number) => void;
  requestRename: (id: string) => void;
  clearRenameRequest: () => void;
  requestDocxEdit: (tabId: string) => void;
  clearDocxEditRequest: () => void;
  requestFileChatDraft: (request: {
    fileFieldId: string;
    markdown: ComposerSource;
  }) => void;
  clearFileChatDraft: (sequence: number) => void;
  requestBlockScroll: (request: {
    tabId: string;
    blockId: string;
    text?: string | undefined;
  }) => void;
  /** Retires one handled block-scroll request. A `seq` that no longer matches
   *  the pending request is a no-op, so a slow consumer finishing an old
   *  scroll cannot swallow a newer one. */
  clearPendingBlockScroll: (seq: number) => void;
  requestPdfPageScroll: (request: {
    tabId: string;
    pageNumber: number;
  }) => void;
  clearPendingPdfPageScroll: () => void;
  clearCommandsForMissingTabs: (tabIds: ReadonlySet<string>) => void;
};

type InspectorAnonymizationActions = {
  acquireAnonymizationActive: () => void;
  releaseAnonymizationActive: () => void;
  publishDocumentTextSelection: (fieldId: string, text: string) => void;
  clearDocumentTextSelection: (fieldId: string) => void;
  publishAnonymizationMatches: (
    fieldId: string,
    snapshot: AnonymizationMatchSnapshot,
  ) => void;
  markAnonymizationPipelineStarted: (fieldId: string) => void;
  markAnonymizationPipelineRan: (fieldId: string) => void;
  markAnonymizationPipelineFailed: (fieldId: string) => void;
  retryAnonymizationPipeline: (fieldId: string) => void;
  clearAnonymizationMatches: (fieldId: string) => void;
  selectAnonymizationTerm: (
    canonical: string,
    label: string,
    source: AnonymizationSelectionSource,
    fieldId: string,
  ) => void;
  clearAnonymizationSelection: () => void;
};

export type InspectorTabsStore = InspectorTabsState & InspectorTabsActions;

export type InspectorCommandStore = InspectorCommandState &
  InspectorCommandActions;

export type InspectorAnonymizationStore = InspectorAnonymizationState &
  InspectorAnonymizationActions;

export type InspectorTabsSet = (
  update: (state: Draft<InspectorTabsStore>) => void,
) => void;

export type InspectorCommandSet = (
  update: (state: Draft<InspectorCommandStore>) => void,
) => void;

export type InspectorAnonymizationSet = (
  update: (state: Draft<InspectorAnonymizationStore>) => void,
) => void;
