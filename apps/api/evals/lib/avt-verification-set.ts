/**
 * A labelled set for the verification eval: documents, the anchor facts they
 * are checked against, and each claim's expected verdict.
 *
 * A set is a JSON file. A case's document is either plain paragraphs (read as
 * DOCX paragraphs are: one block each) or a DOCX or PDF next to the set file,
 * optionally limited to a range of its printed paragraph numbers, as a scoped
 * run is. A claim is located by its exact words in the document, so the same
 * label scores the grader alone (given the claim) and the whole pipeline
 * (given only the document).
 */
import * as v from "valibot";

import {
  FACT_CONFIDENCES,
  FACT_DATE_PRECISIONS,
  FACT_SCORING,
} from "@/api/lib/lists/fact-details";
import { FACT_TIERS } from "@/api/lib/lists/source-kind";
import { CLAIM_STATES } from "@/api/lib/lists/verification/contract";
import { CLAIM_QUALIFIERS } from "@/api/lib/lists/verification/qualifiers";

/** What a labelled claim exercises; the report breaks accuracy down by it. */
export const CLAIM_TAGS = [
  /** Several checkable points in one claim. */
  "compound",
  /** The verdict turns on a date, a period or an order of events. */
  "date",
  /** The verdict turns on a number, an amount or a count. */
  "numeric",
  /** The fact answers a different period, population, place or measure. */
  "scope",
  /** Two facts disagree on the claim's point. */
  "record-conflict",
  /** Only a person's account bears on the claim. */
  "testimony",
  /** The record is not expected to speak to the point. */
  "record-silent",
  /** Checkable, but nothing in the record bears on it. */
  "gap",
  /** A negative or universal claim ("never", "no", "all"). */
  "negation",
  /** Opinion, prediction, hypothetical or private judgment. */
  "opinion",
  /** Hedged or recalled ("approximately", "to my knowledge"). */
  "hedged",
  /** A fact shares people or subject with the claim but not its point. */
  "distractor",
  /** The answer needs a fact the grader can only reach by inference. */
  "inference",
] as const;
export type ClaimTag = (typeof CLAIM_TAGS)[number];

const factSchema = v.strictObject({
  /** Stable label id, unique in its case. */
  id: v.pipe(v.string(), v.minLength(1)),
  text: v.pipe(v.string(), v.minLength(1)),
  occurredOn: v.nullable(v.string()),
  occurredOnPrecision: v.nullable(v.picklist(FACT_DATE_PRECISIONS)),
  evidenceKind: v.nullable(v.string()),
  medium: v.nullable(v.string()),
  confidence: v.nullable(v.picklist(FACT_CONFIDENCES)),
  interpretationNote: v.nullable(v.string()),
  /** Held facts never reach the grader, as in a run. */
  scoring: v.optional(v.picklist(FACT_SCORING), "included"),
  /** The fact's footing: what its sources are. */
  tier: v.optional(v.picklist(FACT_TIERS), "document"),
});
export type LabelledFact = v.InferOutput<typeof factSchema>;

const claimSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  /** The claim's words exactly as the document has them. */
  quote: v.pipe(v.string(), v.minLength(1)),
  /** For a paragraphs document, the 1-based paragraph the quote is in. */
  paragraph: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  verdict: v.picklist(CLAIM_STATES),
  /** Other verdicts a careful reviewer would also accept. */
  accepted: v.optional(v.array(v.picklist(CLAIM_STATES)), []),
  /** Facts a scored verdict should rest on (any of them is a hit). */
  cites: v.optional(v.array(v.string()), []),
  /** Facts that may be cited without being wrong. */
  related: v.optional(v.array(v.string()), []),
  /** The two facts of a record conflict, in any order. */
  conflict: v.optional(v.tuple([v.string(), v.string()])),
  /** Qualifiers the claim should carry, grader and system alike. */
  qualifiers: v.optional(v.array(v.picklist(CLAIM_QUALIFIERS)), []),
  /** A judgement call: reported, never in the headline score. */
  uncertain: v.optional(v.boolean(), false),
  tags: v.optional(v.array(v.picklist(CLAIM_TAGS)), []),
  /** Why the label is what it is. */
  note: v.string(),
});
export type LabelledClaim = v.InferOutput<typeof claimSchema>;

const documentSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("paragraphs"),
    paragraphs: v.pipe(v.array(v.string()), v.minLength(1)),
  }),
  v.strictObject({
    kind: v.literal("file"),
    /** Relative to the set file. */
    path: v.pipe(v.string(), v.minLength(1)),
    /** Printed paragraph numbers, inclusive, as a scoped run takes them. */
    range: v.optional(
      v.strictObject({
        from: v.pipe(v.number(), v.integer(), v.minValue(1)),
        to: v.pipe(v.number(), v.integer(), v.minValue(1)),
      }),
    ),
  }),
]);

const caseSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  title: v.string(),
  document: documentSchema,
  facts: v.array(factSchema),
  claims: v.array(claimSchema),
});
export type LabelledCase = v.InferOutput<typeof caseSchema>;

export const labelledSetSchema = v.strictObject({
  version: v.literal(1),
  id: v.pipe(v.string(), v.minLength(1)),
  description: v.string(),
  cases: v.pipe(v.array(caseSchema), v.minLength(1)),
});
export type LabelledSet = v.InferOutput<typeof labelledSetSchema>;

/** Label ids that do not resolve, or repeat, in a case: a set with any is
 *  refused before a model is called. */
export const labelProblems = (set: LabelledSet): string[] =>
  set.cases.flatMap((item) => {
    const problems: string[] = [];
    const factIds = new Set<string>();
    for (const fact of item.facts) {
      if (factIds.has(fact.id)) {
        problems.push(`${item.id}: fact ${fact.id} repeats`);
      }
      factIds.add(fact.id);
    }
    const claimIds = new Set<string>();
    for (const claim of item.claims) {
      const where = `${item.id}/${claim.id}`;
      if (claimIds.has(claim.id)) {
        problems.push(`${where}: claim id repeats`);
      }
      claimIds.add(claim.id);
      for (const factId of [
        ...claim.cites,
        ...claim.related,
        ...(claim.conflict ?? []),
      ]) {
        if (!factIds.has(factId)) {
          problems.push(`${where}: names unknown fact ${factId}`);
        }
      }
      if (
        (claim.verdict === "recordconflict") !==
        (claim.conflict !== undefined)
      ) {
        problems.push(
          `${where}: a record conflict, and only one, names its two facts`,
        );
      }
      if (
        item.document.kind === "paragraphs" &&
        (claim.paragraph === undefined ||
          claim.paragraph > item.document.paragraphs.length ||
          !(item.document.paragraphs[claim.paragraph - 1] ?? "").includes(
            claim.quote,
          ))
      ) {
        problems.push(`${where}: quote is not in its paragraph`);
      }
    }
    return problems;
  });
