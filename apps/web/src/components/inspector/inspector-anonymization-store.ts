import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import {
  createInspectorAnonymizationSlice,
  EMPTY_ANONYMIZATION_MATCH_SNAPSHOT,
} from "@/components/inspector/inspector-anonymization-slice";
import type {
  AnonymizationMatchSnapshot,
  DocumentTextSelection,
  InspectorAnonymizationStore,
} from "@/components/inspector/inspector-store-types";

export const useInspectorAnonymizationStore =
  create<InspectorAnonymizationStore>()(
    immer((set) => createInspectorAnonymizationSlice(set)),
  );

export const useIsAnonymizationActive = (): boolean =>
  useInspectorAnonymizationStore(
    (state) => state.anonymizationActiveMountCount > 0,
  );

export const useDocumentTextSelection = (
  fieldId: string | null,
): DocumentTextSelection | null =>
  useInspectorAnonymizationStore((state) =>
    fieldId === null
      ? null
      : (state.documentTextSelectionByFieldId[fieldId] ?? null),
  );

export const useAnonymizationMatches = (
  fieldId: string | null,
): AnonymizationMatchSnapshot =>
  useInspectorAnonymizationStore(
    (state) =>
      (fieldId ? state.anonymizationMatchesByFieldId[fieldId] : undefined) ??
      EMPTY_ANONYMIZATION_MATCH_SNAPSHOT,
  );

export const useAnonymizationMatchesReady = (fieldId: string | null): boolean =>
  useInspectorAnonymizationStore((state) =>
    fieldId === null
      ? false
      : !state.anonymizationPipelineStartedFieldIds.has(fieldId),
  );
