import { create } from "zustand";

import type { WebApiRoutes } from "@/lib/api";
import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";

/** Where a new fact comes from: a document, a page of it, and the words.
 *  The document's live version is read when the source is written. */
type FactSourceInput = {
  documentId: string;
  pageNumber: number | null;
  quote: string | null;
};

export type AddFactInput = { statement: string; source: FactSourceInput };

/** Each submitted write keeps its request across panel remounts. A source
 * version is resolved once, before its first submission, and retained with
 * its replay key until that submission succeeds. */
export type AddedFact = {
  input: AddFactInput;
  createRequest: IdempotentRequest;
  recheckKey: string;
} & (
  | { step: "creating" }
  | { step: "added" | "sourced" | "linked"; entityId: string }
  | {
      step: "sourcing";
      entityId: string;
      sourceRequest: {
        body: WebApiRoutes["lists"][":workspaceId"]["item-sources"]["post"]["body"];
        request: IdempotentRequest;
      };
    }
);

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
