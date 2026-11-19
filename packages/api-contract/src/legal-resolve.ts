import * as v from "valibot";

import { decisionReviewsSchema } from "./case-law-reviews";

const legalResolveCandidateSchema = v.strictObject({
  decisionId: v.string(),
  identifier: v.string(),
  label: v.string(),
  readerUrl: v.string(),
});

const otherCourtCandidateSchema = v.strictObject({
  ...legalResolveCandidateSchema.entries,
  court: v.string(),
  decisionDate: v.nullable(v.string()),
  decisionType: v.nullable(v.string()),
  subjectSummary: v.nullable(v.string()),
});

const otherCourtCandidatesSchema = v.optional(
  v.array(otherCourtCandidateSchema),
);

const legalResolveDecisionTextSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("readable"),
    charCount: v.number(),
  }),
  v.strictObject({
    status: v.literal("withheld"),
    reason: v.literal("licence"),
  }),
  v.strictObject({ status: v.literal("unavailable") }),
]);

/**
 * One block of a resolved provision's bounded preview: the publisher's block
 * id, the anchor it sits under and its plain text. The provision preview
 * reader bounds how many blocks and how much text a preview carries.
 */
const legalResolveProvisionBlockSchema = v.strictObject({
  id: v.string(),
  anchorId: v.string(),
  text: v.string(),
});

const legalResolveDecisionAlternateSchema = v.strictObject({
  decisionId: v.string(),
  language: v.string(),
});

const legalResolveDocumentSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("decision"),
    decisionId: v.string(),
    identifier: v.string(),
    country: v.string(),
    caseNumber: v.string(),
    ecli: v.nullable(v.string()),
    court: v.string(),
    decisionDate: v.nullable(v.string()),
    language: v.string(),
    languageAlternates: v.array(legalResolveDecisionAlternateSchema),
    readerUrl: v.string(),
    text: legalResolveDecisionTextSchema,
    appealReviews: decisionReviewsSchema,
  }),
  v.strictObject({
    kind: v.literal("provision"),
    documentId: v.string(),
    eli: v.string(),
    country: v.string(),
    title: v.string(),
    section: v.string(),
    readerUrl: v.string(),
    inForce: v.strictObject({
      from: v.nullable(v.string()),
      to: v.nullable(v.string()),
    }),
    versionStatus: v.picklist(["current", "outdated"]),
    blocks: v.array(legalResolveProvisionBlockSchema),
  }),
]);

/** A run of calendar years, both ends inclusive. */
const yearRangeSchema = v.strictObject({ from: v.number(), to: v.number() });

/**
 * What one source's reconciled listing says about a decision resolve did not
 * find, over the years the identifier allows it to carry (its filing or ECLI
 * year through the current year; every year the source holds when the
 * identifier names none).
 *
 * - `not_published`: every one of those years is in the publisher listing
 *   stella reconciled against its corpus, complete. The publisher does not
 *   list the decision, so scanning its site finds nothing more.
 * - `incomplete`: some of those years are reconciled with decisions stella is
 *   known to miss (`gapYears`), or are not reconciled (`unreconciledYears`);
 *   the publisher may hold it there and only there.
 * - `not_reconciled`: the source's listing is not reconciled at all.
 */
const decisionAbsenceSourceVerdictSchema = v.variant("verdict", [
  v.strictObject({
    verdict: v.literal("not_published"),
    source: v.string(),
    sourceName: v.string(),
    years: yearRangeSchema,
  }),
  v.strictObject({
    verdict: v.literal("incomplete"),
    source: v.string(),
    sourceName: v.string(),
    years: yearRangeSchema,
    gapYears: v.array(
      v.strictObject({ year: v.number(), missing: v.number() }),
    ),
    unreconciledYears: v.array(yearRangeSchema),
  }),
  v.strictObject({
    verdict: v.literal("not_reconciled"),
    source: v.string(),
    sourceName: v.string(),
    reason: v.string(),
  }),
]);

/**
 * Why a decision is absent, as far as the reconciled publisher listings can
 * tell: one verdict per source that could hold the identifier (narrowed by
 * the court it names, or its docket register), as of the coverage snapshot.
 * `unavailable` when the snapshot could not be read.
 */
const decisionAbsenceCoverageSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("read"),
    asOf: v.string(),
    sources: v.array(decisionAbsenceSourceVerdictSchema),
  }),
  v.strictObject({ status: v.literal("unavailable") }),
]);

export type DecisionAbsenceCoverage = v.InferOutput<
  typeof decisionAbsenceCoverageSchema
>;
export type DecisionAbsenceSourceVerdict = v.InferOutput<
  typeof decisionAbsenceSourceVerdictSchema
>;

/** The shared wire result for statute and decision identity resolution. */
export const legalResolveResponseSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("resolved"),
    document: legalResolveDocumentSchema,
    otherCourtCandidates: otherCourtCandidatesSchema,
  }),
  v.strictObject({
    status: v.literal("not_found"),
    hint: v.optional(v.string()),
    reason: v.picklist([
      "unknown_document",
      "unknown_section",
      "no_exact_identity",
      "not_at_this_court",
      "court_unrecognized",
    ]),
    otherCourtCandidates: otherCourtCandidatesSchema,
    /** Set on a decision's `no_exact_identity`. */
    coverage: v.optional(decisionAbsenceCoverageSchema),
  }),
  v.strictObject({
    status: v.literal("ambiguous"),
    candidates: v.array(legalResolveCandidateSchema),
    otherCourtCandidates: otherCourtCandidatesSchema,
  }),
  v.strictObject({
    status: v.literal("incomplete_identifier"),
    missing: v.array(v.string()),
    otherCourtCandidates: otherCourtCandidatesSchema,
  }),
  v.strictObject({ status: v.literal("country_unavailable") }),
]);

export type LegalResolveResponse = v.InferOutput<
  typeof legalResolveResponseSchema
>;
