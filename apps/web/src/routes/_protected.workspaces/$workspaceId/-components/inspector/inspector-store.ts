import { v7 as uuidv7 } from "uuid";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type PdfTab = {
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
  facet?: "preview" | "metadata" | "versions" | "suggestions" | undefined;
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
};

export type ChatTab = {
  type: "chat";
  id: string;
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

export type InspectorTab = PdfTab | TaskTab | ChatTab;

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
};

type Actions = {
  openPdf: (tab: Omit<PdfTab, "type">) => void;
  /**
   * Open or update the inspector tab pinned to a given entity. If a
   * PdfTab for this entity already exists, its `id` (the file
   * field) and content fields are swapped in place — the user sees
   * one continuous tab even when paging through the file's
   * versions. If no such tab exists, behaves like `openPdf` and
   * creates one. The canonical entrypoint for "show this file in
   * the inspector"; routes that surface different versions of the
   * same file (the document route, the version facet) call this so
   * version switches don't multiply tabs.
   */
  openPdfForEntity: (tab: Omit<PdfTab, "type">) => void;
  openTask: (taskId: string, label?: string, isNew?: boolean) => void;
  /**
   * Open a chat tab. Without args, creates a new (local-only) chat
   * with a generated id. Pass `id` + optional `threadId` to restore
   * an existing thread; pass `contextMatterIds` to seed the chat's
   * matter context (typically the matter the user opened it in).
   */
  openChat: (args?: {
    id?: string;
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
  closeTab: (id: string) => void;
  /** Close every tab except the one with the given id. */
  closeOthers: (id: string) => void;
  setActive: (id: string) => void;
  closeAll: () => void;
  /** Ask the active tab's ribbon to start renaming. */
  requestRename: (id: string) => void;
  /** Clear the rename flag once the ribbon has consumed it. */
  clearRenameRequest: () => void;
  clearTaskNewFlag: (taskId: string) => void;
  replacePdfFieldId: (oldFieldId: string, newFieldId: string) => void;
  setPdfMetadataLane: (
    tabId: string,
    metadataLane: PdfTab["metadataLane"],
  ) => void;
  /**
   * Set the active facet for a fullscreen-bound file tab. Pass
   * `pulse: true` when the change is programmatic (e.g. AI just
   * queued suggestions) so the facet bar plays its teaching pulse;
   * leave it false for plain user clicks.
   */
  setPdfFacet: (
    tabId: string,
    facet: NonNullable<PdfTab["facet"]>,
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

export const useInspectorStore = create<State & Actions>()(
  immer((set) => ({
    tabs: [],
    activeId: null,
    activationSeq: 0,
    pendingRenameTabId: null,
    minimized: false,
    pendingBlockScroll: null,

    openPdf: (tab) =>
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
            if (tab.pdfFileId !== undefined) {
              existing.pdfFileId = tab.pdfFileId;
            }
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

    openPdfForEntity: (tab) =>
      set((state) => {
        // Same single-tab-per-file invariant as openPdf, but
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
            if (tab.pdfFileId !== undefined) {
              existing.pdfFileId = tab.pdfFileId;
            }
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

    openTask: (taskId, label = "", isNew = false) =>
      set((state) => {
        const existing = state.tabs.find((t) => t.id === taskId);
        if (!existing) {
          state.tabs.push({
            type: "task",
            id: taskId,
            label,
            isNew,
          });
        } else if (existing.type === "task") {
          if (label) {
            existing.label = label;
          }
          if (isNew) {
            existing.isNew = true;
          }
        }
        state.activeId = taskId;
        state.activationSeq += 1;
        state.minimized = false;
      }),

    openChat: (args = {}) =>
      set((state) => {
        const id = args.id ?? uuidv7();
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

    replacePdfFieldId: (oldFieldId, newFieldId) =>
      set((state) => {
        const tab = state.tabs.find(
          (t) => t.type === "pdf" && t.id === oldFieldId,
        );
        if (!tab || tab.type !== "pdf") {
          return;
        }

        // Keep the renamed tab, but drop any stale tab already using the target id.
        state.tabs = state.tabs.filter(
          (t) => t.id === oldFieldId || t.id !== newFieldId,
        );
        tab.id = newFieldId;
        if (tab.justificationFieldId === oldFieldId) {
          tab.justificationFieldId = newFieldId;
        }
        if (state.activeId === oldFieldId) {
          state.activeId = newFieldId;
        }
      }),

    setPdfMetadataLane: (tabId, metadataLane) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (tab?.type === "pdf") {
          tab.metadataLane = metadataLane;
        }
      }),

    setPdfFacet: (tabId, facet, options) =>
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
