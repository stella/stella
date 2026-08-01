import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { BoundingBox } from "@stll/api/types";

import type { JustificationId, WorkspaceJustification } from "@/lib/types";

type ActiveJustification = {
  id: string;
  pageNumber: number;
};

type FolderState = {
  allExpanded: boolean;
  hasFolders: boolean;
  toggleVersion: number;
};

type PdfViewerState = {
  activePropertyId: string | null;
  pendingAnonymizeEntityId: number | null;
  scaleOffset: number;
  sidebar: "none" | "entity" | "anonymize" | "versions";
};

type State = {
  pendingBoundingBoxIds: Set<string>;
  justifications: WorkspaceJustification[];
  extractionPreviews: Map<string, string>;
  activeJustification: ActiveJustification | null;
  pdfPageCount: number;
  pdfViewer: PdfViewerState;
  folderState: FolderState;
  filesystemSelectedIds: Set<string>;
  expandedTableRowEntityId: string | null;
};

type Actions = {
  syncJustifications: (justifications: WorkspaceJustification[]) => void;
  clearJustifications: () => void;
  getJustifications: (
    justificationIds: JustificationId[],
  ) => WorkspaceJustification[];
  getExtractionPreview: (entityId: string, propertyId: string) => string | null;
  setExtractionPreview: (preview: {
    entityId: string;
    propertyId: string;
    answer: string;
  }) => void;
  clearExtractionPreview: (entityId: string, propertyId: string) => void;
  clearExtractionPreviews: () => void;
  setJustificationBoundingBoxes: (
    justificationId: string,
    boundingesBox: { version: number; boxes: BoundingBox[] },
  ) => void;
  setPendingBoundingBoxId: (
    justificationId: string,
    action: "add" | "remove",
  ) => void;
  setActiveJustification: (justification: ActiveJustification | null) => void;
  setPdfPageCount: (count: number) => void;
  setPdfActivePropertyId: (propertyId: string | null) => void;
  setPendingAnonymizeEntityId: (entityId: number | null) => void;
  setPdfScaleOffset: (scaleOffset: number) => void;
  setPdfSidebar: (sidebar: PdfViewerState["sidebar"]) => void;
  setPdfViewerState: (state: Partial<PdfViewerState>) => void;
  resetPdfViewerState: () => void;
  setFolderState: (state: Omit<FolderState, "toggleVersion">) => void;
  toggleAllFolders: () => void;
  setFilesystemSelectedIds: (selectedIds: Set<string>) => void;
  clearFilesystemSelectedIds: () => void;
  setExpandedTableRowEntityId: (entityId: string | null) => void;
};

const initialPdfViewerState = (): PdfViewerState => ({
  activePropertyId: null,
  pendingAnonymizeEntityId: null,
  scaleOffset: 0,
  sidebar: "entity",
});

const extractionPreviewKey = (entityId: string, propertyId: string) =>
  `${entityId}:${propertyId}`;

// One `fieldId -> justification` index per `justifications` array, memoized on
// the array reference. Immer hands out a fresh `justifications` array only when
// the collection actually changes, so the index is rebuilt once per change and
// shared by every reader — instead of each of the (many) AI cells rescanning
// the whole array on every store tick. The WeakMap lets a superseded array's
// index be collected with it.
const justificationByFieldCache = new WeakMap<
  WorkspaceJustification[],
  Map<string, WorkspaceJustification>
>();

/**
 * O(1) justification-by-field lookup for store selectors. Returns a
 * referentially stable justification (or `undefined`), so a selector built on
 * it only re-renders when that field's justification changes. First match wins,
 * matching the previous `justifications.find((j) => j.fieldId === id)`.
 */
export const selectJustificationByFieldId = (
  justifications: WorkspaceJustification[],
  fieldId: string | null | undefined,
): WorkspaceJustification | undefined => {
  if (fieldId === null || fieldId === undefined) {
    return undefined;
  }
  let index = justificationByFieldCache.get(justifications);
  if (index === undefined) {
    index = new Map<string, WorkspaceJustification>();
    for (const justification of justifications) {
      if (!index.has(justification.fieldId)) {
        index.set(justification.fieldId, justification);
      }
    }
    justificationByFieldCache.set(justifications, index);
  }
  return index.get(fieldId);
};

export const useWorkspaceStore = create<State & Actions>()(
  immer((set, get) => ({
    pendingBoundingBoxIds: new Set(),
    justifications: [],
    extractionPreviews: new Map(),
    activeJustification: null,
    pdfPageCount: 0,
    pdfViewer: initialPdfViewerState(),
    folderState: {
      allExpanded: false,
      hasFolders: false,
      toggleVersion: 0,
    },
    filesystemSelectedIds: new Set(),
    expandedTableRowEntityId: null,

    syncJustifications: (justifications) =>
      set((state) => {
        const justificationsById = new Map(
          state.justifications.map((justification) => [
            justification.id,
            justification,
          ]),
        );

        for (const justification of justifications) {
          if (
            state.pendingBoundingBoxIds.has(justification.id) &&
            justification.boundingBoxes
          ) {
            state.pendingBoundingBoxIds.delete(justification.id);
          }

          justificationsById.set(justification.id, justification);
        }

        state.justifications = [...justificationsById.values()];
      }),
    clearJustifications: () => set({ justifications: [] }),
    getJustifications: (justificationIds) => {
      const store = get();
      const map = new Map(store.justifications.map((j) => [j.id, j]));
      const justifications: WorkspaceJustification[] = [];

      for (const justificationId of justificationIds) {
        const justification = map.get(justificationId);
        if (justification) {
          justifications.push(justification);
        }
      }

      return justifications;
    },
    getExtractionPreview: (entityId, propertyId) =>
      get().extractionPreviews.get(
        extractionPreviewKey(entityId, propertyId),
      ) ?? null,
    setExtractionPreview: ({ entityId, propertyId, answer }) =>
      set((state) => {
        state.extractionPreviews.set(
          extractionPreviewKey(entityId, propertyId),
          answer,
        );
      }),
    clearExtractionPreview: (entityId, propertyId) =>
      set((state) => {
        state.extractionPreviews.delete(
          extractionPreviewKey(entityId, propertyId),
        );
      }),
    clearExtractionPreviews: () =>
      set((state) => {
        state.extractionPreviews = new Map();
      }),
    setJustificationBoundingBoxes: (justificationId, boundingBoxes) =>
      set((state) => {
        const justification = state.justifications.find(
          (j) => j.id === justificationId,
        );

        if (justification) {
          justification.boundingBoxes = boundingBoxes;
        }
      }),
    setPendingBoundingBoxId: (justificationId, action) =>
      set((state) => {
        if (action === "add") {
          state.pendingBoundingBoxIds.add(justificationId);
        } else {
          state.pendingBoundingBoxIds.delete(justificationId);
        }
      }),
    setActiveJustification: (justification) =>
      set({ activeJustification: justification }),
    setPdfPageCount: (count) => set({ pdfPageCount: count }),
    setPdfActivePropertyId: (propertyId) =>
      set((state) => {
        state.pdfViewer.activePropertyId = propertyId;
      }),
    setPendingAnonymizeEntityId: (entityId) =>
      set((state) => {
        state.pdfViewer.pendingAnonymizeEntityId = entityId;
      }),
    setPdfScaleOffset: (scaleOffset) =>
      set((state) => {
        state.pdfViewer.scaleOffset = scaleOffset;
      }),
    setPdfSidebar: (sidebar) =>
      set((state) => {
        state.pdfViewer.sidebar = sidebar;
      }),
    setPdfViewerState: (pdfViewer) =>
      set((state) => {
        Object.assign(state.pdfViewer, pdfViewer);
      }),
    resetPdfViewerState: () =>
      set((state) => {
        state.pdfViewer = initialPdfViewerState();
      }),
    setFolderState: ({ allExpanded, hasFolders }) =>
      set((state) => {
        state.folderState.allExpanded = allExpanded;
        state.folderState.hasFolders = hasFolders;
      }),
    toggleAllFolders: () =>
      set((state) => {
        state.folderState.toggleVersion += 1;
      }),
    setFilesystemSelectedIds: (selectedIds) =>
      set((state) => {
        state.filesystemSelectedIds = new Set(selectedIds);
      }),
    clearFilesystemSelectedIds: () =>
      set((state) => {
        state.filesystemSelectedIds = new Set();
      }),
    setExpandedTableRowEntityId: (entityId) =>
      set((state) => {
        state.expandedTableRowEntityId = entityId;
      }),
  })),
);
