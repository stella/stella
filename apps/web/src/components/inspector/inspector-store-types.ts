import type { Draft } from "immer";

import type { TaskStatus } from "@stll/api-contract";

import type { StructuredCloneable } from "@/components/inspector/view-registry";
import type { ChatThreadId } from "@/lib/chat-thread-ref";

export type ExternalTabId = `external:${string}`;

/** Canonical file-inspector facet domain shared by state, UI, and broadcast validation. */
export const FILE_FACETS = [
  "preview",
  "attachments",
  "metadata",
  "versions",
  "suggestions",
  "playbook",
  "anonymization",
] as const;

export type FileFacet = (typeof FILE_FACETS)[number];

export type FileTab = {
  type: "pdf";
  id: string;
  renderId?: string | undefined;
  entityId: string;
  label: string;
  fileName: string;
  mimeType?: string | undefined;
  pdfFileId: string | null;
  workspaceId: string;
  justificationFieldId?: string | undefined;
  propertyId?: string | undefined;
  metadataLane?: "closed" | "expanded" | undefined;
  facet?: FileFacet | undefined;
  facetPulseSeq?: number | undefined;
};

export type TaskTab = {
  type: "task";
  id: string;
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
  activeDecisionId?: string | undefined;
  activeSkill?:
    | {
        skillId?: string | undefined;
        skillName: string;
      }
    | undefined;
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
  workspaceId: string | null;
};

export type SkillResourceTabId = `skill-resource:${string}`;

export type SkillResourceTab = {
  type: "skill-resource";
  id: SkillResourceTabId;
  label: string;
  skillName: string;
  skillId: string | null;
  origin: "authored" | "built-in" | "bundled" | "upload" | "url";
  target: "body" | "resource";
  resourcePath: string;
  mimeType: string;
  content: string;
};

export type GenericTab = {
  type: "view";
  viewType: string;
  id: string;
  label: string;
  payload: unknown;
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

export type DocumentTextSelection = {
  text: string;
  seq: number;
};

export type AnonymizationMatchSnapshot = {
  totalMatches: number;
  countByCanonical: Map<string, number>;
  labelByCanonical: Map<string, string>;
};

export type AnonymizationSelectionSource = "doc" | "sidebar";

export type AnonymizationSelection = {
  canonical: string | null;
  label: string | null;
  source: AnonymizationSelectionSource | null;
  fieldId: string | null;
  seq: number;
};

export type InspectorTabsState = {
  tabs: InspectorTab[];
  activeId: string | null;
  activationSeq: number;
  flashTabId: string | null;
  flashSeq: number;
  minimized: boolean;
  reviveSuggestion: InspectorTab | null;
};

export type InspectorCommandState = {
  desktopOpenAttention: {
    fieldId: string;
    sequence: number;
  } | null;
  pendingRenameTabId: string | null;
  pendingBlockScroll: {
    tabId: string;
    blockId: string;
    text?: string | undefined;
  } | null;
  pendingPdfPageScroll: {
    tabId: string;
    pageNumber: number;
  } | null;
  pendingDocxEditTabId: string | null;
  /** A composer draft handed to the chat over one document (a review
   *  finding to discuss); the overlay for that file consumes it. */
  pendingFileChatDraft: {
    fileFieldId: string;
    html: string;
    sequence: number;
  } | null;
};

export type InspectorAnonymizationState = {
  anonymizationActiveMountCount: number;
  documentTextSelectionByFieldId: Record<string, DocumentTextSelection>;
  anonymizationMatchesByFieldId: Record<string, AnonymizationMatchSnapshot>;
  anonymizationPipelineStartedFieldIds: Set<string>;
  anonymizationSelection: AnonymizationSelection;
};

export type CloseTabOptions = {
  suggestRevive?: boolean;
};

export type FileFieldReplacement = {
  id: string;
  fileName?: string | undefined;
  label?: string | undefined;
  mimeType?: string | undefined;
  pdfFileId?: string | null | undefined;
  propertyId?: string | undefined;
};

export type InspectorTabsActions = {
  openFile: (tab: Omit<FileTab, "type">) => void;
  openFileForEntity: (tab: Omit<FileTab, "type">) => void;
  openTask: (args: {
    taskId: string;
    workspaceId: string;
    label?: string;
    isNew?: boolean;
  }) => void;
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
    tab: Omit<SkillResourceTab, "type" | "id" | "target"> & {
      refreshContent?: boolean | undefined;
      skillName: string;
      resourcePath: string;
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
    activeDecisionId?: string;
    activeSkill?: ChatTab["activeSkill"];
  }) => void;
  setChatContext: (tabId: string, matterIds: string[]) => void;
  resetChatTabId: (oldId: ChatThreadId, newId: ChatThreadId) => void;
  openView: <P>(args: {
    type: string;
    id: string;
    label: string;
    payload: StructuredCloneable<P>;
    ownerRouteId?: string;
  }) => void;
  updateView: <P>(args: {
    id: string;
    label: string;
    payload: StructuredCloneable<P>;
  }) => void;
  closeTabsForRoute: (routeId: string) => void;
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
  updateTaskStatus: (taskId: string, status: TaskStatus | null) => void;
  flashTab: (tabId: string) => void;
  setMinimized: (minimized: boolean) => void;
  toggleMinimized: () => void;
};

export type InspectorCommandActions = {
  requestDesktopOpenAttention: (fieldId: string) => void;
  clearDesktopOpenAttention: (sequence: number) => void;
  requestRename: (id: string) => void;
  clearRenameRequest: () => void;
  requestDocxEdit: (tabId: string) => void;
  clearDocxEditRequest: () => void;
  requestFileChatDraft: (request: {
    fileFieldId: string;
    html: string;
  }) => void;
  clearFileChatDraft: (sequence: number) => void;
  requestBlockScroll: (request: {
    tabId: string;
    blockId: string;
    text?: string | undefined;
  }) => void;
  clearPendingBlockScroll: () => void;
  requestPdfPageScroll: (request: {
    tabId: string;
    pageNumber: number;
  }) => void;
  clearPendingPdfPageScroll: () => void;
  clearCommandsForMissingTabs: (tabIds: ReadonlySet<string>) => void;
};

export type InspectorAnonymizationActions = {
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
