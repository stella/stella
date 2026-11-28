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
import type { DecisionIdentifierIntent } from "@stll/api-contract/decision-query-intent";
import { decisionDocketGrammarForCountry } from "@stll/case-law-ingestion-core/adapter-manifest";
import { splitCaseReference } from "@stll/case-law-ingestion-core/case-number";
import { stripCitationPrefix } from "@stll/legal-ast/citation-prefix";

import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { NO_SOURCE } from "@/api/lib/workflow/decisions/answer-questions";
import type { AnswerSource } from "@/api/lib/workflow/decisions/answer-questions";
import type { Decision } from "@/api/lib/workflow/decisions/decide";
import type { ChoiceAnswer } from "@/api/lib/workflow/decisions/system-one";

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

/**
 * One corpus a cited identifier is looked up in. A bare docket can be
 * well-formed in more than one admitted jurisdiction, and which corpus holds
 * the decision is the answer, not the order the grammars are declared in.
 */
export type CitedDecisionRead = {
  country: PublicCaseLawCountry;
  intent: DecisionIdentifierIntent;
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
 * The corpora a prose citation is looked up in; empty when nothing in it is
 * an identifier a corpus here could hold.
 *
 * An ECLI is read first: it carries its own country, so no docket grammar has
 * to claim it. Passing `grammar: null` asks the shared reader for that alone.
 */
export const readCitedDecision = (citation: string): CitedDecisionRead[] => {
  const bare = splitCaseReference(stripCitationPrefix(citation)).caseNumber;
  const structured = parseDecisionQuery(bare, { grammar: null });
  if (structured.type === "identifier" && structured.kind === "ecli") {
    const country = ecliCountry(structured.value);
    return country === null ? [] : [{ country, intent: structured }];
  }

  const reads: CitedDecisionRead[] = [];
  for (const country of PUBLIC_CASE_LAW_COUNTRIES) {
    const intent = parseDecisionQuery(bare, {
      grammar: decisionDocketGrammarForCountry(country),
    });
    if (intent.type === "identifier" && intent.kind === "docket") {
      reads.push({ country, intent });
    }
  }
  return reads;
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
  const ordered = rows.toSorted((left, right) => {
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
export type CitationCheckDecision = Pick<
  DecisionIdentityRow,
  | "id"
  | "caseNumber"
  | "country"
  | "court"
  | "courtAbbreviation"
  | "decisionDate"
  | "language"
  | "languageAlternates"
  | "slug"
>;

export const citationCheckDecision = (
  row: DecisionIdentityRow,
): CitationCheckDecision => ({
  id: row.id,
  caseNumber: row.caseNumber,
  country: row.country,
  court: row.court,
  courtAbbreviation: row.courtAbbreviation,
  decisionDate: row.decisionDate,
  language: row.language,
  languageAlternates: row.languageAlternates,
  slug: row.slug,
});

export type CitationReading = {
  relation: CitationRelationReading;
  /** Probability of the relation the model chose; null when it is uncertain. */
  probability: number | null;
  /** The model's confidence; null when it declined to answer. */
  confidence: number | null;
  passage: { anchor: string; text: string } | null;
};

/**
 * Why a reading could not be made at all. A refusal or an answer under the
 * floor is a reading ("uncertain"); these are not.
 */
export type CitationReadingFailure = "no_model" | "failed";

type ReadCitationRelationOptions = {
  relation: Decision<ChoiceAnswer<CitationRelation>>;
  /** The where-question's decision; null when it was not asked. */
  where: Decision<ChoiceAnswer> | null;
  sources: readonly AnswerSource[];
};

/**
 * The decision model's two answers as one reading.
 *
 * Below the confidence floor, or when the model declines, the relation is
 * reported as uncertain: a reader deciding whether to open the decision is
 * better served by that than by a label the model did not earn. A passage is
 * named only when the where-question was decided on one the request offered.
 */
export const readCitationRelation = ({
  relation,
  sources,
  where,
}: ReadCitationRelationOptions):
  | { type: "read"; reading: CitationReading }
  | { type: "failed"; reason: CitationReadingFailure } => {
  const passage = (() => {
    if (where?.state !== "decided" || where.answer.choice === NO_SOURCE) {
      return null;
    }
    const chosen = sources.find((source) => source.id === where.answer.choice);
    return chosen === undefined
      ? panic("The decision model chose a passage the request did not offer")
      : { anchor: chosen.id, text: chosen.text };
  })();
  if (relation.state === "decided") {
    return {
      type: "read",
      reading: {
        relation: relation.answer.choice,
        probability: relation.probability,
        confidence: relation.confidence,
        passage,
      },
    };
  }
  switch (relation.reason) {
    case "below-floor":
    case "refusal":
      return {
        type: "read",
        reading: {
          relation: CITATION_RELATION_UNCERTAIN,
          probability: null,
          confidence: relation.confidence,
          passage: null,
        },
      };
    case "no-backend":
      return { type: "failed", reason: "no_model" };
    case "failed":
      return { type: "failed", reason: "failed" };
    default:
      relation.reason satisfies never;
      return panic("Unhandled undecided citation reading");
  }
};
