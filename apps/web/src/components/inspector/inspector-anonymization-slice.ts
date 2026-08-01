import { original } from "immer";

import type {
  AnonymizationMatchSnapshot,
  InspectorAnonymizationSet,
  InspectorAnonymizationStore,
} from "@/components/inspector/inspector-store-types";

export const EMPTY_ANONYMIZATION_MATCH_SNAPSHOT: AnonymizationMatchSnapshot = {
  totalMatches: 0,
  countByCanonical: new Map(),
  labelByCanonical: new Map(),
};

const withFieldAdded = (fields: Set<string>, fieldId: string): Set<string> => {
  if (fields.has(fieldId)) {
    return fields;
  }
  const next = new Set(fields);
  next.add(fieldId);
  return next;
};

const withFieldRemoved = (
  fields: Set<string>,
  fieldId: string,
): Set<string> => {
  if (!fields.has(fieldId)) {
    return fields;
  }
  const next = new Set(fields);
  next.delete(fieldId);
  return next;
};

export const createInspectorAnonymizationSlice = (
  set: InspectorAnonymizationSet,
): InspectorAnonymizationStore => ({
  anonymizationActiveMountCount: 0,
  documentTextSelectionByFieldId: {},
  anonymizationMatchesByFieldId: {},
  anonymizationPipelineStartedFieldIds: new Set(),
  anonymizationSelection: {
    canonical: null,
    label: null,
    source: null,
    fieldId: null,
    seq: 0,
  },

  acquireAnonymizationActive: () =>
    set((state) => {
      state.anonymizationActiveMountCount += 1;
    }),

  releaseAnonymizationActive: () =>
    set((state) => {
      state.anonymizationActiveMountCount = Math.max(
        0,
        state.anonymizationActiveMountCount - 1,
      );
    }),

  publishDocumentTextSelection: (fieldId, text) =>
    set((state) => {
      const previous = state.documentTextSelectionByFieldId[fieldId];
      state.documentTextSelectionByFieldId[fieldId] = {
        text,
        seq: (previous?.seq ?? 0) + 1,
      };
    }),

  clearDocumentTextSelection: (fieldId) =>
    set((state) => {
      if (!(fieldId in state.documentTextSelectionByFieldId)) {
        return;
      }
      state.documentTextSelectionByFieldId = Object.fromEntries(
        Object.entries(state.documentTextSelectionByFieldId).filter(
          ([id]) => id !== fieldId,
        ),
      );
    }),

  publishAnonymizationMatches: (fieldId, snapshot) =>
    set((state) => {
      state.anonymizationMatchesByFieldId[fieldId] = snapshot;
    }),

  markAnonymizationPipelineStarted: (fieldId) =>
    set((state) => {
      const pipelineFields =
        original(state).anonymizationPipelineStartedFieldIds;
      state.anonymizationPipelineStartedFieldIds = withFieldAdded(
        pipelineFields,
        fieldId,
      );
    }),

  markAnonymizationPipelineRan: (fieldId) =>
    set((state) => {
      const pipelineFields =
        original(state).anonymizationPipelineStartedFieldIds;
      state.anonymizationPipelineStartedFieldIds = withFieldRemoved(
        pipelineFields,
        fieldId,
      );
    }),

  clearAnonymizationMatches: (fieldId) =>
    set((state) => {
      const hadMatches = fieldId in state.anonymizationMatchesByFieldId;
      const pipelineFields =
        original(state).anonymizationPipelineStartedFieldIds;
      const nextStarted = withFieldRemoved(pipelineFields, fieldId);
      if (!hadMatches && nextStarted === pipelineFields) {
        return;
      }
      state.anonymizationMatchesByFieldId = hadMatches
        ? Object.fromEntries(
            Object.entries(state.anonymizationMatchesByFieldId).filter(
              ([id]) => id !== fieldId,
            ),
          )
        : state.anonymizationMatchesByFieldId;
      state.anonymizationPipelineStartedFieldIds = nextStarted;
    }),

  selectAnonymizationTerm: (canonical, label, source, fieldId) =>
    set((state) => {
      state.anonymizationSelection = {
        canonical,
        label,
        source,
        fieldId,
        seq: state.anonymizationSelection.seq + 1,
      };
    }),

  clearAnonymizationSelection: () =>
    set((state) => {
      state.anonymizationSelection = {
        canonical: null,
        label: null,
        source: null,
        fieldId: null,
        seq: 0,
      };
    }),
});
