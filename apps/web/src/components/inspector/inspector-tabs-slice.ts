import { panic } from "better-result";
import { current, type Draft } from "immer";
import { v7 as uuidv7 } from "uuid";

import type {
  ExternalTabId,
  FileTab,
  InspectorTab,
  InspectorTabsSet,
  InspectorTabsStore,
  MatterTabId,
  SkillResourceTabId,
  TaskTab,
} from "@/components/inspector/inspector-store-types";
import { getInspectorView } from "@/components/inspector/view-registry";
import { normalizeOptionalArray } from "@/lib/arrays";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { isEmailFile } from "@/lib/consts";

export const buildSkillResourceTabId = ({
  skillName,
  resourcePath,
}: {
  skillName: string;
  resourcePath: string;
}): SkillResourceTabId => `skill-resource:${skillName}/${resourcePath}`;

export const isGenericInspectorTab = (
  tab: InspectorTab,
): tab is Extract<InspectorTab, { type: "view" }> => tab.type === "view";

const isMainViewBoundTab = (tab: InspectorTab): boolean => {
  if (tab.type === "pdf") {
    return tab.metadataLane === "expanded";
  }
  if (tab.type !== "view") {
    return false;
  }
  return (
    tab.ownerRouteId !== undefined &&
    getInspectorView(tab.viewType)?.navigationPolicy === "close-on-route-leave"
  );
};

const dropSupersededFileSuggestion = (
  state: Pick<InspectorTabsStore, "reviveSuggestion">,
  tab: Pick<FileTab, "id" | "entityId">,
) => {
  const suggestion = state.reviveSuggestion;
  if (suggestion === null) {
    return;
  }
  if (
    suggestion.id === tab.id ||
    (suggestion.type === "pdf" && suggestion.entityId === tab.entityId)
  ) {
    state.reviveSuggestion = null;
  }
};

const FILE_TAB_RENDER_ID_POLICY = {
  always: "always",
  whenIdChanges: "when-id-changes",
} as const;

type UpsertFileTabOptions = {
  renderIdPolicy: (typeof FILE_TAB_RENDER_ID_POLICY)[keyof typeof FILE_TAB_RENDER_ID_POLICY];
};

const normalizeFileTabFacet = (tab: Draft<FileTab>): void => {
  if (
    tab.facet === "attachments" &&
    !isEmailFile({ fileName: tab.fileName, mimeType: tab.mimeType })
  ) {
    tab.facet = "preview";
  }
};

const upsertFileTab = (
  state: Draft<InspectorTabsStore>,
  tab: Omit<FileTab, "type">,
  { renderIdPolicy }: UpsertFileTabOptions,
) => {
  const matchIndex = state.tabs.findIndex(
    (candidate) =>
      candidate.type === "pdf" &&
      (candidate.entityId === tab.entityId || candidate.id === tab.id),
  );
  if (matchIndex === -1) {
    state.tabs.push({ type: "pdf", renderId: uuidv7(), ...tab });
    state.activeId = tab.id;
    return;
  }

  const existing = state.tabs[matchIndex];
  if (existing?.type !== "pdf") {
    return;
  }

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
  existing.fileName = tab.fileName;
  if (tab.mimeType !== undefined) {
    existing.mimeType = tab.mimeType;
  }
  normalizeFileTabFacet(existing);
  existing.pdfFileId = tab.pdfFileId;
  if (
    renderIdPolicy === FILE_TAB_RENDER_ID_POLICY.always ||
    previousId !== tab.id
  ) {
    existing.renderId = uuidv7();
  }
  state.tabs = state.tabs.filter(
    (candidate, index) =>
      index === matchIndex ||
      !(
        candidate.type === "pdf" &&
        (candidate.entityId === tab.entityId || candidate.id === tab.id)
      ),
  );
  if (state.activeId === previousId) {
    state.activeId = tab.id;
  }
};

const upsertTaskTab = (state: Draft<InspectorTabsStore>, tab: TaskTab) => {
  const existing = state.tabs.find((candidate) => candidate.id === tab.id);
  if (!existing) {
    state.tabs.push(tab);
    return;
  }
  if (existing.type !== "task") {
    return;
  }
  if (tab.label) {
    existing.label = tab.label;
  }
  if (tab.isNew) {
    existing.isNew = true;
  }
  existing.workspaceId = tab.workspaceId;
};

export const createInspectorTabsSlice = (
  set: InspectorTabsSet,
): InspectorTabsStore => ({
  tabs: [],
  activeId: null,
  activationSeq: 0,
  flashTabId: null,
  flashSeq: 0,
  minimized: false,
  reviveSuggestion: null,

  openFile: (tab) =>
    set((state) => {
      upsertFileTab(state, tab, {
        renderIdPolicy: FILE_TAB_RENDER_ID_POLICY.whenIdChanges,
      });
      state.activeId = tab.id;
      state.activationSeq += 1;
      state.minimized = false;
      dropSupersededFileSuggestion(state, tab);
    }),

  openFileForEntity: (tab) =>
    set((state) => {
      upsertFileTab(state, tab, {
        renderIdPolicy: FILE_TAB_RENDER_ID_POLICY.always,
      });
      state.activationSeq += 1;
      state.minimized = false;
      dropSupersededFileSuggestion(state, tab);
    }),

  openTask: ({ taskId, workspaceId, label = "", isNew = false }) =>
    set((state) => {
      upsertTaskTab(state, {
        type: "task",
        id: taskId,
        creationStatus: "ready",
        label,
        isNew,
        workspaceId,
      });
      state.activeId = taskId;
      state.activationSeq += 1;
      state.minimized = false;
    }),

  // One user action, one activation: opening a selection must leave focus on
  // the tab the caller names, not on whichever target happened to come last.
  openTabs: ({ targets, activeId }) => {
    if (targets.length === 0) {
      return;
    }
    if (!targets.some((target) => target.id === activeId)) {
      panic("openTabs was given an activeId outside its targets");
    }
    set((state) => {
      for (const target of targets) {
        switch (target.type) {
          case "pdf":
            upsertFileTab(state, target, {
              renderIdPolicy: FILE_TAB_RENDER_ID_POLICY.whenIdChanges,
            });
            dropSupersededFileSuggestion(state, target);
            break;
          case "task":
            upsertTaskTab(state, target);
            break;
          default:
            target satisfies never;
            panic("Unhandled inspector open target");
        }
      }
      state.activeId = activeId;
      state.activationSeq += 1;
      state.minimized = false;
    });
  },

  openPendingTask: ({ workspaceId, label = "" }) => {
    const pendingTaskId = `pending-task:${uuidv7()}`;
    set((state) => {
      state.tabs.push({
        type: "task",
        id: pendingTaskId,
        creationStatus: "pending",
        label,
        isNew: true,
        workspaceId,
      });
      state.activeId = pendingTaskId;
      state.activationSeq += 1;
      state.minimized = false;
    });
    return pendingTaskId;
  },

  resolvePendingTask: ({ pendingTaskId, taskId }) =>
    set((state) => {
      const pendingTab = state.tabs.find(
        (tab) => tab.type === "task" && tab.id === pendingTaskId,
      );
      if (
        pendingTab?.type !== "task" ||
        pendingTab.creationStatus !== "pending"
      ) {
        return;
      }

      state.tabs = state.tabs.filter(
        (tab) => tab.id === pendingTaskId || tab.id !== taskId,
      );
      pendingTab.id = taskId;
      pendingTab.creationStatus = "ready";
      if (state.activeId === pendingTaskId) {
        state.activeId = taskId;
      }
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
    workspaceId,
  }) =>
    set((state) => {
      const id: ExternalTabId = `external:${url}`;
      let fallbackLabel = url;
      try {
        fallbackLabel = new URL(url).hostname;
      } catch {
        // Keep the raw URL as a last-resort tab label.
      }
      const existing = state.tabs.find((tab) => tab.id === id);
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
          workspaceId,
        });
      } else if (existing.type === "external") {
        existing.label = label ?? existing.label;
        existing.connectorSlug = connectorSlug ?? existing.connectorSlug;
        existing.iconHref = iconHref ?? existing.iconHref;
        existing.provider = provider ?? existing.provider;
        existing.snippet = snippet ?? existing.snippet;
        existing.sourceToolName = sourceToolName ?? existing.sourceToolName;
        existing.text = text ?? existing.text;
        existing.workspaceId = workspaceId;
      }
      state.activeId = id;
      state.activationSeq += 1;
      state.minimized = false;
    }),

  openMatter: ({ workspaceId, label, color }) =>
    set((state) => {
      const id: MatterTabId = `matter:${workspaceId}`;
      const existing = state.tabs.find((tab) => tab.id === id);
      if (!existing) {
        state.tabs.push({ type: "matter", id, label, workspaceId, color });
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
    refreshContent = false,
    target = "resource",
  }) =>
    set((state) => {
      const id = buildSkillResourceTabId({ skillName, resourcePath });
      const existing = state.tabs.find((tab) => tab.id === id);
      if (!existing) {
        state.tabs.push({
          type: "skill-resource",
          id,
          label,
          skillName,
          skillId,
          origin,
          target,
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
        existing.target = target;
        existing.resourcePath = resourcePath;
        existing.mimeType = mimeType;
        if (sourceChanged || refreshContent) {
          existing.content = content;
        }
      }
      state.activeId = id;
      state.activationSeq += 1;
      state.minimized = false;
    }),

  updateSkillResourceTabContent: (tabId, content) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (tab?.type === "skill-resource") {
        tab.content = content;
      }
    }),

  openChat: (args = {}) =>
    set((state) => {
      const id = args.id ?? createChatThreadId();
      const existing = state.tabs.find((tab) => tab.id === id);
      if (!existing) {
        state.tabs.push({
          type: "chat",
          id,
          label: args.label ?? "New chat",
          workspaceId: args.workspaceId,
          contextMatterIds: normalizeOptionalArray(args.contextMatterIds),
          activeDecisionId: args.activeDecisionId,
          activeSkill: args.activeSkill,
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
        if (args.activeSkill !== undefined) {
          existing.activeSkill = args.activeSkill;
        }
      }
      state.activeId = id;
      state.activationSeq += 1;
      state.minimized = false;
    }),

  setChatContext: (tabId, matterIds) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (tab?.type === "chat") {
        tab.contextMatterIds = matterIds;
      }
    }),

  resetChatTabId: (oldId, newId) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === oldId);
      if (tab?.type === "chat") {
        tab.id = newId;
      }
      if (state.activeId === oldId) {
        state.activeId = newId;
      }
    }),

  openView: ({ type, id, label, payload, ownerRouteId }) =>
    set((state) => {
      const existing = state.tabs.find((tab) => tab.id === id);
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
      if (state.reviveSuggestion?.id === id) {
        state.reviveSuggestion = null;
      }
    }),

  updateView: ({ id, label, payload }) =>
    set((state) => {
      const existing = state.tabs.find((tab) => tab.id === id);
      if (!existing || !isGenericInspectorTab(existing)) {
        return;
      }
      existing.label = label;
      existing.payload = payload;
    }),

  flashTab: (tabId) =>
    set((state) => {
      state.flashTabId = tabId;
      state.flashSeq += 1;
    }),

  closeTabsForRoute: (routeId) =>
    set((state) => {
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
      if (
        removed.size > 0 &&
        state.activeId !== null &&
        removed.has(state.activeId)
      ) {
        state.activeId = state.tabs.at(0)?.id ?? null;
      }
    }),

  closeTab: (id, options) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) {
        if (state.reviveSuggestion?.id === id) {
          state.reviveSuggestion = null;
        }
        return;
      }
      const closing = state.tabs[index];
      if (
        closing !== undefined &&
        options?.suggestRevive === true &&
        isMainViewBoundTab(closing)
      ) {
        state.reviveSuggestion = current(closing);
      } else if (state.reviveSuggestion?.id === id) {
        state.reviveSuggestion = null;
      }
      state.tabs.splice(index, 1);
      if (state.activeId === id) {
        const next = state.tabs[Math.min(index, state.tabs.length - 1)];
        state.activeId = next?.id ?? null;
      }
    }),

  closeOthers: (id) =>
    set((state) => {
      const target = state.tabs.find((tab) => tab.id === id);
      if (!target) {
        return;
      }
      const closingBound = state.tabs.find(
        (tab) => tab.id !== id && isMainViewBoundTab(tab),
      );
      if (closingBound !== undefined) {
        state.reviveSuggestion = current(closingBound);
      }
      state.tabs = [target];
      state.activeId = id;
    }),

  reviveSuggestedTab: () =>
    set((state) => {
      const suggestion = state.reviveSuggestion;
      if (suggestion === null) {
        return;
      }
      state.reviveSuggestion = null;
      if (!state.tabs.some((tab) => tab.id === suggestion.id)) {
        state.tabs.push(suggestion);
      }
      state.activeId = suggestion.id;
      state.activationSeq += 1;
      state.minimized = false;
    }),

  clearReviveSuggestion: () =>
    set((state) => {
      state.reviveSuggestion = null;
    }),

  setActive: (id) =>
    set((state) => {
      state.activeId = id;
      state.activationSeq += 1;
    }),

  closeAll: () =>
    set((state) => {
      const closingBound = state.tabs.find(isMainViewBoundTab);
      if (closingBound !== undefined) {
        state.reviveSuggestion = current(closingBound);
      }
      state.tabs = [];
      state.activeId = null;
    }),

  clearTaskNewFlag: (taskId) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === taskId);
      if (tab?.type === "task") {
        tab.isNew = false;
      }
    }),

  replaceFileFieldId: (oldFieldId, replacement) =>
    set((state) => {
      const tab = state.tabs.find(
        (candidate) => candidate.type === "pdf" && candidate.id === oldFieldId,
      );
      if (tab?.type !== "pdf") {
        return;
      }
      const next =
        typeof replacement === "string" ? { id: replacement } : replacement;
      state.tabs = state.tabs.filter(
        (candidate) => candidate.id === oldFieldId || candidate.id !== next.id,
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
      if (next.fileName) {
        tab.fileName = next.fileName;
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
      normalizeFileTabFacet(tab);
      if (state.activeId === oldFieldId) {
        state.activeId = next.id;
      }
    }),

  setFileMetadataLane: (tabId, metadataLane) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (tab?.type === "pdf") {
        tab.metadataLane = metadataLane;
        return;
      }
      if (
        metadataLane !== "expanded" &&
        state.reviveSuggestion?.type === "pdf" &&
        state.reviveSuggestion.id === tabId
      ) {
        state.reviveSuggestion = null;
      }
    }),

  setFileFacet: (tabId, facet, options) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (tab?.type !== "pdf") {
        return;
      }
      tab.facet = facet;
      if (options?.pulse) {
        tab.facetPulseSeq = (tab.facetPulseSeq ?? 0) + 1;
        state.minimized = false;
      }
    }),

  updateLabel: (tabId, label) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (tab) {
        tab.label = label;
      }
    }),

  updateTaskStatus: (taskId, status) =>
    set((state) => {
      const tab = state.tabs.find(
        (candidate) => candidate.type === "task" && candidate.id === taskId,
      );
      if (tab?.type === "task") {
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
});

export const closeTabsForDeletedEntities = (
  state: Pick<InspectorTabsStore, "activeId" | "reviveSuggestion" | "tabs">,
  entityIds: readonly string[],
) => {
  const deletedEntityIds = new Set(entityIds);
  const isDeletedEntityTab = (tab: InspectorTab) =>
    (tab.type === "pdf" && deletedEntityIds.has(tab.entityId)) ||
    (tab.type === "task" && deletedEntityIds.has(tab.id));
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeId);
  const activeTab = state.tabs[activeIndex];
  const activeId =
    activeTab !== undefined && isDeletedEntityTab(activeTab)
      ? (state.tabs
          .slice(activeIndex + 1)
          .find((tab) => !isDeletedEntityTab(tab))?.id ??
        state.tabs
          .slice(0, activeIndex)
          .findLast((tab) => !isDeletedEntityTab(tab))?.id ??
        null)
      : state.activeId;
  const tabs = state.tabs.filter((tab) => !isDeletedEntityTab(tab));
  const reviveSuggestion =
    state.reviveSuggestion !== null &&
    isDeletedEntityTab(state.reviveSuggestion)
      ? null
      : state.reviveSuggestion;

  return { activeId, reviveSuggestion, tabs };
};

type SharedInspectorTabsState = Pick<
  InspectorTabsStore,
  "activationSeq" | "activeId" | "reviveSuggestion" | "tabs"
>;

/** Merge cross-window tabs without overwriting state owned by this window. */
export const reconcileSharedInspectorTabs = (
  state: SharedInspectorTabsState,
  sharedTabs: InspectorTab[],
): SharedInspectorTabsState => {
  const localViewTabs = state.tabs.filter(isGenericInspectorTab);
  const tabs: InspectorTab[] = [...sharedTabs, ...localViewTabs];
  const activeId =
    state.activeId !== null && tabs.some((tab) => tab.id === state.activeId)
      ? state.activeId
      : (tabs.at(0)?.id ?? null);
  return {
    tabs,
    activeId,
    reviveSuggestion:
      state.reviveSuggestion !== null &&
      tabs.some((tab) => tab.id === state.reviveSuggestion?.id)
        ? null
        : state.reviveSuggestion,
    activationSeq:
      activeId === state.activeId
        ? state.activationSeq
        : state.activationSeq + 1,
  };
};
