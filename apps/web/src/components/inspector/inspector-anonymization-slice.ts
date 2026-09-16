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

export const createInspectorAnonymizationSlice = (
  set: InspectorAnonymizationSet,
): InspectorAnonymizationStore => ({
  anonymizationActiveMountCount: 0,
  documentTextSelectionByFieldId: {},
  anonymizationMatchesByFieldId: {},
  anonymizationPipelineStatusByFieldId: {},
  anonymizationRetryByFieldId: {},
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
      state.anonymizationPipelineStatusByFieldId[fieldId] = "running";
    }),

  markAnonymizationPipelineRan: (fieldId) =>
    set((state) => {
      state.anonymizationPipelineStatusByFieldId[fieldId] = "ready";
    }),

  markAnonymizationPipelineFailed: (fieldId) =>
    set((state) => {
      state.anonymizationPipelineStatusByFieldId[fieldId] = "error";
    }),

  retryAnonymizationPipeline: (fieldId) =>
    set((state) => {
      state.anonymizationPipelineStatusByFieldId[fieldId] = "idle";
      state.anonymizationRetryByFieldId[fieldId] =
        (state.anonymizationRetryByFieldId[fieldId] ?? 0) + 1;
    }),

  clearAnonymizationMatches: (fieldId) =>
    set((state) => {
      if (
        !(fieldId in state.anonymizationMatchesByFieldId) &&
        !(fieldId in state.anonymizationPipelineStatusByFieldId) &&
        !(fieldId in state.anonymizationRetryByFieldId)
      ) {
        return;
      }
      state.anonymizationMatchesByFieldId = Object.fromEntries(
        Object.entries(state.anonymizationMatchesByFieldId).filter(
          ([id]) => id !== fieldId,
        ),
      );
      state.anonymizationPipelineStatusByFieldId = Object.fromEntries(
        Object.entries(state.anonymizationPipelineStatusByFieldId).filter(
          ([id]) => id !== fieldId,
        ),
      );
      state.anonymizationRetryByFieldId = Object.fromEntries(
        Object.entries(state.anonymizationRetryByFieldId).filter(
          ([id]) => id !== fieldId,
        ),
      );
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
