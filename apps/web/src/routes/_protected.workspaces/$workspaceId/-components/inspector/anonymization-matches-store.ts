/**
 * Live snapshot of which anonymization terms are currently
 * highlighted in the open document.
 *
 * The Folio editor produces the match list (workspace catalog +
 * worker-detected entities) and publishes it here on every
 * dispatch / poll tick; the inspector facet reads the same store
 * to show "N terms highlighted" and to filter the workspace
 * vocabulary list to only the entries that actually appear in
 * the open file.
 *
 * Keyed by the document's `fieldId` so when the user switches
 * between docs the inspector sees zero matches for an
 * unmonitored field rather than stale numbers from another doc.
 */

import { create } from "zustand";

export type AnonymizationMatchSnapshot = {
  /** Total occurrence count across the whole doc. */
  totalMatches: number;
  /**
   * Per-canonical hit count. Keys mirror the term's `canonical`
   * string and values are the number of occurrences in the open
   * document. Use `.has(canonical)` for membership (matching
   * workspace terms only) and `.get(canonical)` for badges.
   */
  countByCanonical: ReadonlyMap<string, number>;
  /**
   * Per-canonical label (e.g. "person", "organization"). Used by
   * the inspector facet to group the detected list by category
   * and show a category badge per row. First occurrence wins
   * when a canonical somehow appears under multiple labels.
   */
  labelByCanonical: ReadonlyMap<string, string>;
};

type State = {
  byFieldId: Record<string, AnonymizationMatchSnapshot>;
  /**
   * Field ids for which the detection pipeline (the
   * chat-anon worker) has delivered at least one
   * result. Distinct from `byFieldId` because Folio
   * publishes an empty snapshot on plugin init, before
   * the worker has had a chance to run; reading
   * `byFieldId` alone would tell the inspector facet
   * "ready, 0 matches" the moment the editor mounts.
   */
  pipelineRanFieldIds: ReadonlySet<string>;
};

type Actions = {
  publish: (fieldId: string, snapshot: AnonymizationMatchSnapshot) => void;
  markPipelineRan: (fieldId: string) => void;
  clear: (fieldId: string) => void;
};

export const useAnonymizationMatchesStore = create<State & Actions>((set) => ({
  byFieldId: {},
  pipelineRanFieldIds: new Set(),
  publish: (fieldId, snapshot) =>
    set((state) => ({
      byFieldId: { ...state.byFieldId, [fieldId]: snapshot },
    })),
  markPipelineRan: (fieldId) =>
    set((state) => {
      if (state.pipelineRanFieldIds.has(fieldId)) {
        return state;
      }
      const next = new Set(state.pipelineRanFieldIds);
      next.add(fieldId);
      return { pipelineRanFieldIds: next };
    }),
  clear: (fieldId) =>
    set((state) => {
      const hadMatches = fieldId in state.byFieldId;
      const hadRan = state.pipelineRanFieldIds.has(fieldId);
      if (!hadMatches && !hadRan) {
        return state;
      }
      let nextRan: ReadonlySet<string> = state.pipelineRanFieldIds;
      if (hadRan) {
        const mutable = new Set(state.pipelineRanFieldIds);
        mutable.delete(fieldId);
        nextRan = mutable;
      }
      return {
        byFieldId: hadMatches
          ? Object.fromEntries(
              Object.entries(state.byFieldId).filter(([id]) => id !== fieldId),
            )
          : state.byFieldId,
        pipelineRanFieldIds: nextRan,
      };
    }),
}));

const EMPTY_SNAPSHOT: AnonymizationMatchSnapshot = {
  totalMatches: 0,
  countByCanonical: new Map(),
  labelByCanonical: new Map(),
};

export const useAnonymizationMatches = (
  fieldId: string | null,
): AnonymizationMatchSnapshot =>
  useAnonymizationMatchesStore(
    (s) => (fieldId ? s.byFieldId[fieldId] : undefined) ?? EMPTY_SNAPSHOT,
  );

/**
 * True once the detection pipeline has delivered at least one
 * result for `fieldId`. Lets the inspector facet distinguish
 * "detection still warming up" from "detection ran and found
 * nothing", so an empty result doesn't masquerade as a buggy
 * zero. Note: Folio publishes an empty snapshot on plugin init,
 * so we explicitly track pipeline completion via
 * `markPipelineRan` rather than reading `byFieldId`.
 */
export const useAnonymizationMatchesReady = (fieldId: string | null): boolean =>
  useAnonymizationMatchesStore((s) =>
    fieldId === null ? false : s.pipelineRanFieldIds.has(fieldId),
  );
