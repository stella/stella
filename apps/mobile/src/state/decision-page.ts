import type { Decision } from "@/state/case-law";
import { plainTextBlocks, readerBlocks } from "@/state/decision-document";
import type { ReaderBlock } from "@/state/decision-document";

/**
 * A decision as the reader's web view draws it, all of it plain data: what
 * the decision is, its headnote, its text in blocks, and the publisher's page.
 * The app's words come in already translated, since the web view has no
 * catalogue of its own.
 */
export type DecisionPage = {
  readonly caseNumber: string;
  /** Court, kind and date, in that order, those the decision has. */
  readonly details: readonly string[];
  readonly ecli: string | null;
  readonly headnote: { readonly label: string; readonly text: string } | null;
  readonly blocks: readonly ReaderBlock[];
  /** What the reader says when it has no text to show. */
  readonly unavailable: string;
  /** The publisher's own page for the decision, when it is a web address. */
  readonly source: { readonly label: string; readonly href: string } | null;
};

/** The app's words the page shows, in the person's language. */
type DecisionPageLabels = {
  readonly headnote: string;
  readonly textUnavailable: string;
  readonly openSource: string;
};

const WEB_URL = /^https?:\/\//iu;

/** Whether an address opens in a browser, the only kind the reader follows. */
export const isWebUrl = (url: string): boolean => WEB_URL.test(url.trim());

export const decisionPage = ({
  decision,
  decided,
  labels,
}: {
  decision: Decision;
  /** The decision's date as the person's locale writes it, or null. */
  decided: string | null;
  labels: DecisionPageLabels;
}): DecisionPage => ({
  caseNumber: decision.caseNumber,
  details: [decision.court, decision.decisionType, decided].filter(
    (detail): detail is string => detail !== null && detail !== "",
  ),
  ecli: decision.ecli,
  headnote:
    decision.headnote === null
      ? null
      : { label: labels.headnote, text: decision.headnote },
  blocks:
    decision.blocks === null
      ? plainTextBlocks(decision.fulltext ?? "")
      : readerBlocks(decision.blocks, decision.sourceUrl),
  unavailable: labels.textUnavailable,
  source:
    decision.sourceUrl === null || !isWebUrl(decision.sourceUrl)
      ? null
      : { label: labels.openSource, href: decision.sourceUrl.trim() },
});
