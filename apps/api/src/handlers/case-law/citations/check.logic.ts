/**
 * Reading a citation as prose writes it, and shaping what the check answers.
 *
 * Nothing here touches a database, a corpus index or a model: the identifier
 * is normalized with the readers the search box and the citator already use,
 * and the model's answer is turned into a response. Both halves are the parts
 * with rules, so both are testable without a deployment.
 *
 * A prose citation is not a box entry. It carries the word the court prints
 * before the number (`sp. zn.`, `č. j.`) and often the sheet number of the
 * file (`-130`), which names a page and not the decision. Those two are
 * stripped by their owning readers before a docket grammar sees anything.
 */

import { panic } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import type { PublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { CITATION_RELATION_UNCERTAIN } from "@stll/api-contract/citation-check";
import type {
  CitationRelation,
  CitationRelationReading,
} from "@stll/api-contract/citation-check";
import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";
import { stripCitationPrefix } from "@stll/legal-ast/citation-prefix";

import { splitCaseReference } from "@/api/handlers/case-law/case-number";
import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import {
  NO_SOURCE,
  SYSTEM_ONE_ACCEPT_CONFIDENCE,
} from "@/api/lib/typesafe/answer-questions";
import type { AnswerSource } from "@/api/lib/typesafe/answer-questions";

/**
 * The rubric each relation is judged by, written for the lawyer whose
 * sentence is being checked rather than for the model's convenience. Total
 * over the shared vocabulary, so a relation added to the contract has no
 * criterion until someone writes one.
 */
export const CITATION_RELATION_CRITERIA = {
  supports:
    "The decision's own reasoning or holding states what `claim` says. The court says it itself; a party's submission or a lower court's reasoning that the decision merely reports is not the court saying it.",
  contradicts:
    "The decision states the opposite of `claim`, or rejects the proposition `claim` makes. A narrower rule than `claim` asserts, or an exception the claim ignores, contradicts it.",
  does_not_address:
    "The decision does not deal with the point `claim` makes. It may concern a neighbouring question, or mention the subject without ruling on it.",
} as const satisfies Record<CitationRelation, string>;

/** What the `where` question offers when no listed passage carries the reading. */
export const NO_PASSAGE_CRITERION =
  "No listed passage carries the court's treatment of `claim`.";

export type CitedDecisionLookup = {
  kind: "docket" | "ecli";
  /** The identifier as the grammars normalized it, for the exact-identity filter. */
  identifier: string;
  /**
   * Every admitted jurisdiction whose grammar claims this identifier. A bare
   * docket can be well-formed in more than one of them, and which corpus
   * actually holds the decision is the answer, not the grammar order.
   */
  countries: PublicCaseLawCountry[];
};

/** The alpha-3 an ECLI's own country field names, when a corpus here holds it. */
const ecliCountry = (ecli: string): PublicCaseLawCountry | null => {
  const field = ecli.split(":")[1];
  if (field === undefined) {
    return null;
  }
  // `EU` is not an ISO code but is a corpus of its own, so it is admitted by
  // name before the ISO reader, which would reject it.
  const named = publicCaseLawCountry(field);
  if (named !== null) {
    return named;
  }
  const read = normalizeCountry(field, { spelling: "alpha-3" });
  return read.ok ? publicCaseLawCountry(read.value.alpha3) : null;
};

/**
 * The decision a prose citation names, or null when nothing in it is an
 * identifier a corpus here could hold.
 *
 * An ECLI is read first: it carries its own country, so no docket grammar has
 * to claim it. Passing `grammar: null` is how the shared reader is asked for
 * that question alone, since it disables docket parsing and leaves the ECLI
 * check.
 */
export const readCitedDecision = (
  citation: string,
): CitedDecisionLookup | null => {
  const bare = splitCaseReference(stripCitationPrefix(citation)).caseNumber;
  const structured = parseDecisionQuery(bare, { grammar: null });
  if (structured.type === "identifier") {
    const country = ecliCountry(structured.value);
    return country === null
      ? null
      : { kind: "ecli", identifier: structured.value, countries: [country] };
  }

  const countries: PublicCaseLawCountry[] = [];
  let identifier: string | null = null;
  for (const country of PUBLIC_CASE_LAW_COUNTRIES) {
    const intent = parseDecisionQuery(bare, {
      grammar: decisionDocketGrammarForCountry(country),
    });
    if (intent.type !== "identifier") {
      continue;
    }
    // Every grammar formats a docket by folding it, so the jurisdictions that
    // claim one all spell it the same way.
    identifier = intent.value;
    countries.push(country);
  }
  return identifier === null ? null : { kind: "docket", identifier, countries };
};

/**
 * Order by code point. An ISO date and a decision id are not language, so
 * collation has nothing to say about either, and a date's own digits already
 * sort chronologically.
 */
const compareCodePoints = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

export type CitedDecisionChoice = {
  chosen: DecisionIdentityRow;
  /** The other decisions answering to the same reference, in the same order. */
  alternatives: DecisionIdentityRow[];
};

/**
 * One reference can be the docket of several decisions, at one court over
 * time or at several courts at once. The most recent is checked and the rest
 * are listed, so the reader sees that the reference was not unique rather
 * than being handed one decision as though it were.
 */
export const chooseCitedDecision = (
  rows: readonly DecisionIdentityRow[],
): CitedDecisionChoice | null => {
  const ordered = [...rows].sort((left, right) => {
    // A row with no date cannot claim to be the most recent, so it sorts last
    // rather than sorting as the empty string, which would make it the oldest.
    if (left.decisionDate !== right.decisionDate) {
      if (left.decisionDate === null) {
        return 1;
      }
      if (right.decisionDate === null) {
        return -1;
      }
      return compareCodePoints(right.decisionDate, left.decisionDate);
    }
    return compareCodePoints(left.id, right.id);
  });
  const [chosen, ...alternatives] = ordered;
  return chosen === undefined ? null : { chosen, alternatives };
};

/**
 * A decision as the check names it. `country` and `language` are here for the
 * decision route, which is keyed by both: without them a caller could print
 * the case number but not link to what it names.
 */
export type CitationCheckDecision = {
  id: string;
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: string | null;
  language: string;
  slug: string | null;
};

export const citationCheckDecision = (
  row: DecisionIdentityRow,
): CitationCheckDecision => ({
  id: row.id,
  caseNumber: row.caseNumber,
  country: row.country,
  court: row.court,
  decisionDate: row.decisionDate,
  language: row.language,
  slug: row.slug,
});

export type CitationReading = {
  relation: CitationRelationReading;
  /** Probability of the relation the model chose, reported even when uncertain. */
  probability: number;
  probabilities: Record<CitationRelation, number>;
  confidence: number;
  passage: { anchor: string; text: string } | null;
};

type ReadCitationRelationOptions = {
  relation: {
    choice: CitationRelation;
    probabilities: Record<CitationRelation, number>;
    confidence: number;
  };
  /** The source id the `where` question chose, or `__none`. */
  where: string;
  sources: readonly AnswerSource[];
};

/**
 * The model's two answers as one reading.
 *
 * Below the acceptance floor the relation is reported as uncertain and the
 * distribution still goes out: a reader deciding whether to open the decision
 * is better served by "60/40 between supports and does not address" than by a
 * label the model did not earn.
 */
export const readCitationRelation = ({
  relation,
  sources,
  where,
}: ReadCitationRelationOptions): CitationReading => {
  const chosen = sources.find((source) => source.id === where);
  if (chosen === undefined && where !== NO_SOURCE) {
    return panic("Jev chose a passage the request did not offer");
  }
  return {
    relation:
      relation.confidence < SYSTEM_ONE_ACCEPT_CONFIDENCE
        ? CITATION_RELATION_UNCERTAIN
        : relation.choice,
    probability: relation.probabilities[relation.choice],
    probabilities: relation.probabilities,
    confidence: relation.confidence,
    passage:
      chosen === undefined ? null : { anchor: chosen.id, text: chosen.text },
  };
};
