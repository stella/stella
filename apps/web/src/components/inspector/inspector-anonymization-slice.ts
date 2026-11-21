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
  anonymizationDetectionsByFieldId: {},
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

  retryAnonymizationPipeline: (fieldId) => {
    const retries: (() => void)[] = [];
    set((state) => {
      state.anonymizationPipelineStatusByFieldId[fieldId] = "idle";
      state.anonymizationRetryByFieldId[fieldId] =
        (state.anonymizationRetryByFieldId[fieldId] ?? 0) + 1;
      const registrations = state.anonymizationDetectionsByFieldId[fieldId];
      if (registrations === undefined) {
        return;
      }
      for (const registration of registrations) {
        retries.push(registration.retry);
      }
    });
    for (const retry of retries) {
      retry();
    }
  },

  clearAnonymizationMatches: (fieldId) =>
    set((state) => {
      // Another mounted editor still owns this field's live detection.
      if (fieldId in state.anonymizationDetectionsByFieldId) {
        return;
      }
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

  // Stored as arrays rather than Sets: immer drafts Sets only with its MapSet
  // plugin, and functions are kept by reference, so identity removal works.
  registerAnonymizationDetection: (fieldId, registration) =>
    set((state) => {
      const confirms = state.anonymizationDetectionsByFieldId[fieldId];
      if (confirms === undefined) {
        state.anonymizationDetectionsByFieldId[fieldId] = [registration];
        return;
      }
      if (confirms.some((entry) => entry.confirm === registration.confirm)) {
        return;
      }
      state.anonymizationDetectionsByFieldId[fieldId] = [
        ...confirms,
        registration,
      ];
    }),

  unregisterAnonymizationDetection: (fieldId, confirm) =>
    set((state) => {
      const confirms = state.anonymizationDetectionsByFieldId[fieldId];
      if (confirms === undefined) {
        return;
      }
      const remaining = confirms.filter((entry) => entry.confirm !== confirm);
      if (remaining.length > 0) {
        state.anonymizationDetectionsByFieldId[fieldId] = remaining;
        return;
      }
      state.anonymizationDetectionsByFieldId = Object.fromEntries(
        Object.entries(state.anonymizationDetectionsByFieldId).filter(
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
