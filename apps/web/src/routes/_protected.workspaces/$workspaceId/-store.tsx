import type { RowSelectionState } from "@tanstack/react-table";
import { nanoid } from "nanoid";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { BoundingBox } from "@stella/api/types";

import type {
  WorkspaceEntity,
  WorkspaceField,
  WorkspaceJustification,
} from "@/lib/types";

type SetFieldDataProps = {
  propertyId: string;
  entityId: string;
  content: Exclude<WorkspaceField["content"], { type: "file" }> | null;
}[];

type ActiveJustification = {
  id: string;
  pageNumber: number;
};

type FolderState = {
  allExpanded: boolean;
  hasFolders: boolean;
  toggleVersion: number;
};

type State = {
  pendingBoundingBoxIds: Set<string>;
  data: WorkspaceEntity[];
  justifications: WorkspaceJustification[];
  activeJustification: ActiveJustification | null;
  folderState: FolderState;
};

type Actions = {
  syncEntities: (entities: WorkspaceEntity[]) => void;
  syncJustifications: (justifications: WorkspaceJustification[]) => void;
  getEntities: (rowSelection: RowSelectionState) => WorkspaceEntity[];
  getJustifications: (justificationIds: string[]) => WorkspaceJustification[];
  setJustificationBoundingBoxes: (
    justificationId: string,
    boundingesBox: { version: number; boxes: BoundingBox[] },
  ) => void;
  setPendingBoundingBoxId: (
    justificationId: string,
    action: "add" | "remove",
  ) => void;
  setEntityName: (entityId: string, name: string) => void;
  setFieldData: (props: SetFieldDataProps) => void;
  setActiveJustification: (justification: ActiveJustification | null) => void;
  setFolderState: (state: Omit<FolderState, "toggleVersion">) => void;
  toggleAllFolders: () => void;
};

export const useWorkspaceStore = create<State & Actions>()(
  immer((set, get) => ({
    pendingBoundingBoxIds: new Set(),
    data: [],
    justifications: [],
    activeJustification: null,
    hoveredJustificationPageNumber: null,
    folderState: {
      allExpanded: false,
      hasFolders: false,
      toggleVersion: 0,
    },

    syncEntities: (entities) => {
      set({
        data: entities,
      });
    },
    syncJustifications: (justifications) =>
      set((state) => {
        for (const justification of justifications) {
          if (
            state.pendingBoundingBoxIds.has(justification.id) &&
            justification.boundingBoxes
          ) {
            state.pendingBoundingBoxIds.delete(justification.id);
          }
        }

        state.justifications = justifications;
      }),
    getEntities: (rowSelection) => {
      const store = get();

      const selectedRowsCount = Object.keys(rowSelection).length;
      const hasSelectedRows =
        selectedRowsCount > 0 && selectedRowsCount < store.data.length;

      const entities = hasSelectedRows
        ? store.data.filter((entity) => rowSelection[entity.entityId])
        : store.data;

      return entities;
    },
    getJustifications: (justificationIds) => {
      const store = get();
      const justifications: WorkspaceJustification[] = [];

      for (const justificationId of justificationIds) {
        const justification = store.justifications.find(
          (j) => j.id === justificationId,
        );

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

        if (justification && boundingBoxes) {
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
    setEntityName: (entityId, name) =>
      set((state) => {
        const entity = state.data.find((e) => e.entityId === entityId);
        if (entity) {
          entity.name = name;
        }
      }),
    setActiveJustification: (justification) =>
      set({ activeJustification: justification }),
    setFolderState: ({ allExpanded, hasFolders }) =>
      set((state) => {
        state.folderState.allExpanded = allExpanded;
        state.folderState.hasFolders = hasFolders;
      }),
    toggleAllFolders: () =>
      set((state) => {
        state.folderState.toggleVersion += 1;
      }),
    setFieldData: (props) => {
      set((state) => {
        for (const data of props) {
          const entityIndex = state.data.findIndex(
            (entity) => entity.entityId === data.entityId,
          );

          if (entityIndex === -1) {
            return;
          }

          if (data.content === null) {
            delete state.data[entityIndex].fields[data.propertyId];
            continue;
          }

          if (state.data[entityIndex].fields[data.propertyId]) {
            state.data[entityIndex].fields[data.propertyId].content =
              data.content;
          } else {
            state.data[entityIndex].fields[data.propertyId] = {
              id: nanoid(),
              entityId: data.entityId,
              content: data.content,
            };
          }
        }
      });
    },
  })),
);
