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
   * Field ids whose detection pipeline is currently in
   * flight. Producers (the docx chat-anon worker, the
   * PDF wasm runner) call `markPipelineStarted` when
   * they begin and `markPipelineRan` on terminal
   * outcome. The inspector facet uses this together
   * with `pipelineRanFieldIds` to know whether to show
   * the "Detecting…" placeholder — fields with no
   * producer at all (unsupported file types) never
   * enter this set so the facet falls through to the
   * direct count instead of stalling forever.
   */
  pipelineStartedFieldIds: ReadonlySet<string>;
  /**
   * Field ids whose detection pipeline has produced at
   * least one terminal outcome (success or error).
   * Distinct from `byFieldId` because Folio publishes an
   * empty snapshot on plugin init, before the worker
   * has actually run.
   */
  pipelineRanFieldIds: ReadonlySet<string>;
};

type Actions = {
  publish: (fieldId: string, snapshot: AnonymizationMatchSnapshot) => void;
  markPipelineStarted: (fieldId: string) => void;
  markPipelineRan: (fieldId: string) => void;
  clear: (fieldId: string) => void;
};

const withFieldAdded = (
  set: ReadonlySet<string>,
  fieldId: string,
): ReadonlySet<string> => {
  if (set.has(fieldId)) {
    return set;
  }
  const next = new Set(set);
  next.add(fieldId);
  return next;
};

const withFieldRemoved = (
  set: ReadonlySet<string>,
  fieldId: string,
): ReadonlySet<string> => {
  if (!set.has(fieldId)) {
    return set;
  }
  const next = new Set(set);
  next.delete(fieldId);
  return next;
};

export const useAnonymizationMatchesStore = create<State & Actions>((set) => ({
  byFieldId: {},
  pipelineStartedFieldIds: new Set(),
  pipelineRanFieldIds: new Set(),
  publish: (fieldId, snapshot) =>
    set((state) => ({
      byFieldId: { ...state.byFieldId, [fieldId]: snapshot },
    })),
  markPipelineStarted: (fieldId) =>
    set((state) => ({
      pipelineStartedFieldIds: withFieldAdded(
        state.pipelineStartedFieldIds,
        fieldId,
      ),
    })),
  markPipelineRan: (fieldId) =>
    set((state) => ({
      pipelineStartedFieldIds: withFieldRemoved(
        state.pipelineStartedFieldIds,
        fieldId,
      ),
      pipelineRanFieldIds: withFieldAdded(state.pipelineRanFieldIds, fieldId),
    })),
  clear: (fieldId) =>
    set((state) => {
      const hadMatches = fieldId in state.byFieldId;
      const nextStarted = withFieldRemoved(
        state.pipelineStartedFieldIds,
        fieldId,
      );
      const nextRan = withFieldRemoved(state.pipelineRanFieldIds, fieldId);
      if (
        !hadMatches &&
        nextStarted === state.pipelineStartedFieldIds &&
        nextRan === state.pipelineRanFieldIds
      ) {
        return state;
      }
      return {
        byFieldId: hadMatches
          ? Object.fromEntries(
              Object.entries(state.byFieldId).filter(([id]) => id !== fieldId),
            )
          : state.byFieldId,
        pipelineStartedFieldIds: nextStarted,
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
 * True when the inspector facet should treat the current
 * match snapshot as authoritative — either the detection
 * pipeline has finished at least once for this field, or
 * no producer ever started one (so there's nothing to wait
 * for and the facet should render the direct count, even
 * if it's zero). Returns `false` only while a producer is
 * actively in flight, which is the only state where the
 * "Detecting entities…" placeholder is correct.
 */
export const useAnonymizationMatchesReady = (fieldId: string | null): boolean =>
  useAnonymizationMatchesStore((s) => {
    if (fieldId === null) {
      return false;
    }
    if (s.pipelineRanFieldIds.has(fieldId)) {
      return true;
    }
    return !s.pipelineStartedFieldIds.has(fieldId);
  });
