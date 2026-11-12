import { create } from "zustand";

/** Where a new fact comes from: a document, a page of it, and the words.
 *  The document's live version is read when the source is written. */
type FactSourceInput = {
  documentId: string;
  pageNumber: number | null;
  quote: string | null;
};

export type AddFactInput = { statement: string; source: FactSourceInput };

/** How far adding a fact got: added to the list, sourced, linked. Its
 *  re-check's key is chosen once, so a retry whose re-check already landed
 *  replays it instead of grading the claim again. */
export type AddedFact = {
  input: AddFactInput;
  entityId: string;
  step: "added" | "sourced" | "linked";
  recheckKey: string;
};

type AddFactProgressStore = {
  /** Unfinished additions by claim (`addFactProgressKey`). */
  progress: Readonly<Record<string, AddedFact>>;
  record: (key: string, added: AddedFact | null) => void;
};

/**
 * An addition that failed after writing something stays here for the
 * session, outside the claim's panel: switching claims and coming back
 * resumes the same fact instead of adding a second one.
 */
export const useAddFactProgress = create<AddFactProgressStore>()((set) => ({
  progress: {},
  record: (key, added) => {
    set(({ progress }) => {
      const next = Object.fromEntries(
        Object.entries(progress).filter(([entry]) => entry !== key),
      );
      return { progress: added === null ? next : { ...next, [key]: added } };
    });
  },
}));

export const addFactProgressKey = (scope: {
  workspaceId: string;
  runId: string;
  claimId: string;
}) => `${scope.workspaceId}:${scope.runId}:${scope.claimId}`;
