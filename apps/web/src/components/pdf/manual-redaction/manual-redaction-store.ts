import { create } from "zustand";

import {
  type ManualRedactionArea,
  type ManualRedactionAreasAction,
  type ManualRedactionExport,
  reduceManualRedactionAreas,
} from "@/lib/pdf/manual-redaction.logic";

/** Whether the reader's pages take drags as new areas. */
export type ManualRedactionMode = "viewing" | "drawing";

/** The areas drawn on one file tab's PDF; kept in memory only. */
type FieldManualRedaction = {
  documentKey: string;
  areas: readonly ManualRedactionArea[];
  mode: ManualRedactionMode;
};

type ManualRedactionStore = {
  byFieldId: Readonly<Record<string, FieldManualRedaction>>;
  /** Names the PDF the reader shows; a different one drops earlier areas. */
  bindDocument: (fieldId: string, documentKey: string) => void;
  /** Applies only while `documentKey` is still the bound document. */
  dispatch: (options: {
    fieldId: string;
    documentKey: string;
    action: ManualRedactionAreasAction;
  }) => void;
  setMode: (fieldId: string, mode: ManualRedactionMode) => void;
};

export const useManualRedactionStore = create<ManualRedactionStore>()(
  (set) => ({
    byFieldId: {},
    bindDocument: (fieldId, documentKey) =>
      set((state) => {
        if (state.byFieldId[fieldId]?.documentKey === documentKey) {
          return state;
        }
        return {
          byFieldId: {
            ...state.byFieldId,
            [fieldId]: { documentKey, areas: [], mode: "viewing" },
          },
        };
      }),
    dispatch: ({ fieldId, documentKey, action }) =>
      set((state) => {
        const current = state.byFieldId[fieldId];
        if (current?.documentKey !== documentKey) {
          return state;
        }
        const areas = reduceManualRedactionAreas(current.areas, action);
        if (areas === current.areas) {
          return state;
        }
        return {
          byFieldId: {
            ...state.byFieldId,
            [fieldId]: { documentKey, areas, mode: current.mode },
          },
        };
      }),
    setMode: (fieldId, mode) =>
      set((state) => {
        const current = state.byFieldId[fieldId];
        if (current === undefined || current.mode === mode) {
          return state;
        }
        return {
          byFieldId: {
            ...state.byFieldId,
            [fieldId]: {
              documentKey: current.documentKey,
              areas: current.areas,
              mode,
            },
          },
        };
      }),
  }),
);

/** The areas the anonymized download blacks out for this file tab, if any. */
export const readManualRedactionExport = (
  fieldId: string,
): ManualRedactionExport | null => {
  const current = useManualRedactionStore.getState().byFieldId[fieldId];
  if (current === undefined || current.areas.length === 0) {
    return null;
  }
  return { documentKey: current.documentKey, areas: current.areas };
};
