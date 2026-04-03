import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { BoundingBox } from "@stella/api/types";

import type { WorkspaceJustification } from "@/lib/types";

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
  sidebar: "none" | "entity" | "anonymize";
};

type State = {
  pendingBoundingBoxIds: Set<string>;
  justifications: WorkspaceJustification[];
  activeJustification: ActiveJustification | null;
  pdfPageCount: number;
  pdfViewer: PdfViewerState;
  folderState: FolderState;
};

type Actions = {
  syncJustifications: (justifications: WorkspaceJustification[]) => void;
  clearJustifications: () => void;
  getJustifications: (justificationIds: string[]) => WorkspaceJustification[];
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
};

const initialPdfViewerState = (): PdfViewerState => ({
  activePropertyId: null,
  pendingAnonymizeEntityId: null,
  scaleOffset: 0,
  sidebar: "entity",
});

export const useWorkspaceStore = create<State & Actions>()(
  immer((set, get) => ({
    pendingBoundingBoxIds: new Set(),
    justifications: [],
    activeJustification: null,
    pdfPageCount: 0,
    pdfViewer: initialPdfViewerState(),
    folderState: {
      allExpanded: false,
      hasFolders: false,
      toggleVersion: 0,
    },

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
  })),
);
