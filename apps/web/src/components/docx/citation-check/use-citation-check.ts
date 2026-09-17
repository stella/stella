/**
 * Running one citation check from the editor and holding its answer.
 *
 * A check is a user action on a selection, not a read of the document, so it
 * runs in the event handler and lives in component state rather than in a
 * query cache: the answer belongs to the sentence the writer had selected at
 * the time, and caching it by anything else would show it beside a different
 * sentence after an edit.
 */

import { useState } from "react";

import { panic, Result } from "better-result";

import type { CitationRelationReading } from "@stll/api-contract/citation-check";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";

type CheckedDecision = {
  id: string;
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: string | null;
  language: string;
  slug: string | null;
};

export type CitationCheckState =
  | { status: "idle" }
  | { status: "checking"; citation: string; blockId: string | null }
  | { status: "failed"; citation: string; blockId: string | null }
  | { status: "not_found"; citation: string; blockId: string | null }
  | {
      status: "unavailable";
      citation: string;
      blockId: string | null;
      reason: "derived_ai_withheld" | "no_text";
    }
  | {
      status: "checked";
      citation: string;
      blockId: string | null;
      decision: CheckedDecision;
      alternatives: CheckedDecision[];
      relation: CitationRelationReading;
      probability: number;
      passage: { anchor: string; text: string } | null;
    };

export type RunCitationCheck = (request: {
  citation: string;
  claim: string;
  /** The paragraph the selection sits in, so the answer stays keyed to it. */
  blockId: string | null;
}) => Promise<void>;

export type CitationCheckController = {
  state: CitationCheckState;
  run: RunCitationCheck;
  dismiss: () => void;
};

export const useCitationCheck = (): CitationCheckController => {
  const [state, setState] = useState<CitationCheckState>({ status: "idle" });

  const run: RunCitationCheck = async ({ blockId, citation, claim }) => {
    setState({ status: "checking", citation, blockId });
    // `language` is left out: the editor knows the reader's locale, not the
    // language of the document they are writing, and the two differ often
    // enough that guessing would be worse than the decision's own language,
    // which is what the endpoint falls back to.
    const checked = await Result.tryPromise(async () =>
      unwrapEden(await api.case.citations.check.post({ citation, claim })),
    );
    if (Result.isError(checked)) {
      getAnalytics().captureError(checked.error);
      setState({ status: "failed", citation, blockId });
      return;
    }
    const answer = checked.value;
    switch (answer.status) {
      case "not_found":
        setState({ status: "not_found", citation, blockId });
        return;
      case "unavailable":
        setState({
          status: "unavailable",
          citation,
          blockId,
          reason: answer.reason,
        });
        return;
      case "checked":
        setState({
          status: "checked",
          citation,
          blockId,
          decision: answer.decision,
          alternatives: answer.alternatives,
          relation: answer.relation,
          probability: answer.probability,
          passage: answer.passage,
        });
        return;
      default:
        answer satisfies never;
        panic("Unhandled citation-check answer");
    }
  };

  return { state, run, dismiss: () => setState({ status: "idle" }) };
};
