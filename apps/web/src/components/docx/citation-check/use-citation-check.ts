/**
 * Running citation checks from the editor and holding what they answered.
 *
 * An answer belongs to the sentence it was asked about, not to the document,
 * so it lives in component state rather than in a query cache: keyed by
 * anything else it would show up beside a sentence that has since changed.
 * The writer asks for one by selecting a citation; the editor asks for the
 * rest on its own as paragraphs settle, which is why the results accumulate
 * rather than replace each other.
 */

import { useRef, useState } from "react";

import { panic, Result } from "better-result";

import type { CitationRelationReading } from "@stll/api-contract/citation-check";

import {
  citationCheckKey,
  decideAutomaticCitationCheck,
} from "@/components/docx/citation-check/citation-check.logic";
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

/** What the card shows for one finished check. `key` is also its list key. */
export type CitationCheckResult = { key: string; blockId: string | null } & (
  | { status: "failed"; citation: string }
  | { status: "not_found"; citation: string }
  | {
      status: "unavailable";
      citation: string;
      reason: "derived_ai_withheld" | "no_text";
    }
  | {
      status: "checked";
      citation: string;
      decision: CheckedDecision;
      alternatives: CheckedDecision[];
      relation: CitationRelationReading;
      probability: number;
      passage: { anchor: string; text: string } | null;
    }
);

export type CitationCheckState = {
  /** Newest first: the card reads the first entry in full. */
  results: readonly CitationCheckResult[];
  pending: { runId: number; citation: string } | null;
};

/**
 * Who asked. An automatic check is a background read of what the writer is
 * typing, so a failure leaves the card as it was; a check the writer asked
 * for owes them an answer, including that it did not complete.
 */
type CitationCheckOrigin = "manual" | "automatic";

export type CitationCheckController = {
  state: CitationCheckState;
  /**
   * Check the citation in a selection the writer chose. Runs even for a pair
   * already checked: asking again is the point of asking by hand.
   */
  runSelected: (request: {
    citation: string;
    claim: string;
    /** The paragraph the selection sits in, so the answer stays keyed to it. */
    blockId: string | null;
  }) => Promise<void>;
  /** Check the paragraph the caret settled in, if it asks a new question. */
  runSettledParagraph: (request: {
    paragraphText: string;
    blockId: string | null;
  }) => Promise<void>;
  dismiss: () => void;
};

/**
 * How many answers the card keeps. Enough to read a page's citations back
 * without the stack becoming a second document to scroll.
 */
const MAX_RESULTS = 5;

/**
 * How many (reference, sentence) pairs a session remembers asking about.
 * Every settled edit to a cited sentence mints one, so the set is capped and
 * the oldest entries drop out; re-asking about a paragraph the writer left
 * long ago costs one request, never a wrong answer.
 */
const MAX_REMEMBERED_CHECKS = 200;

export const useCitationCheck = (): CitationCheckController => {
  const [state, setState] = useState<CitationCheckState>({
    results: [],
    pending: null,
  });
  // Not state: nothing renders from it, and a check must see the keys its own
  // run just added rather than the ones from the render it started in.
  const checkedRef = useRef(new Set<string>());
  const runIdRef = useRef(0);

  const run = async ({
    blockId,
    citation,
    claim,
    key,
    origin,
  }: {
    blockId: string | null;
    citation: string;
    claim: string;
    key: string;
    origin: CitationCheckOrigin;
  }) => {
    runIdRef.current += 1;
    const runId = runIdRef.current;
    checkedRef.current.add(key);
    if (checkedRef.current.size > MAX_REMEMBERED_CHECKS) {
      const oldest = checkedRef.current.values().next();
      if (!oldest.done) {
        checkedRef.current.delete(oldest.value);
      }
    }
    setState((current) => ({
      results: current.results,
      pending: { runId, citation },
    }));
    // Each answer carries the paragraph it is about, so one that lands after
    // a newer check started is still a true answer: it joins the stack rather
    // than replacing what the writer is looking at.
    const settle = (result: CitationCheckResult) => {
      setState((current) => ({
        results: [
          result,
          ...current.results.filter((earlier) => earlier.key !== result.key),
        ].slice(0, MAX_RESULTS),
        pending: current.pending?.runId === runId ? null : current.pending,
      }));
    };
    const clearPending = () => {
      setState((current) => ({
        results: current.results,
        pending: current.pending?.runId === runId ? null : current.pending,
      }));
    };

    // `language` is left out: the editor knows the reader's locale, not the
    // language of the document they are writing, and the two differ often
    // enough that guessing would be worse than the decision's own language,
    // which is what the endpoint falls back to.
    const checked = await Result.tryPromise(async () =>
      unwrapEden(await api.case.citations.check.post({ citation, claim })),
    );
    if (Result.isError(checked)) {
      getAnalytics().captureError(checked.error);
      // An automatic check is quiet about its own failure: the writer did not
      // ask for it, so a red card over their draft would be noise. The next
      // edit to the sentence asks again under a new key.
      if (origin === "automatic") {
        clearPending();
        return;
      }
      settle({ key, blockId, status: "failed", citation });
      return;
    }
    const answer = checked.value;
    switch (answer.status) {
      case "not_found":
        settle({ key, blockId, status: "not_found", citation });
        return;
      case "unavailable":
        settle({
          key,
          blockId,
          status: "unavailable",
          citation,
          reason: answer.reason,
        });
        return;
      case "checked":
        settle({
          key,
          blockId,
          status: "checked",
          citation,
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

  return {
    state,
    runSelected: async ({ blockId, citation, claim }) => {
      await run({
        blockId,
        citation,
        claim,
        key: citationCheckKey({ citation, claim }),
        origin: "manual",
      });
    },
    runSettledParagraph: async ({ blockId, paragraphText }) => {
      const decision = decideAutomaticCitationCheck({
        checked: checkedRef.current,
        paragraphText,
      });
      if (decision.type === "skip") {
        return;
      }
      await run({
        blockId,
        citation: decision.citation,
        claim: decision.claim,
        key: decision.key,
        origin: "automatic",
      });
    },
    dismiss: () => setState({ results: [], pending: null }),
  };
};
