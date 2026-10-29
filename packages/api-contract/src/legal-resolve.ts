import * as v from "valibot";

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
    blocks: v.array(v.unknown()),
    extent: v.variant("type", [
      v.strictObject({ type: v.literal("complete") }),
      v.strictObject({
        type: v.literal("partial"),
        returnedChars: v.number(),
        totalChars: v.number(),
      }),
    ]),
  }),
  v.strictObject({
    status: v.literal("withheld"),
    reason: v.literal("licence"),
  }),
  v.strictObject({ status: v.literal("unavailable") }),
]);

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
    blocks: v.array(v.unknown()),
  }),
]);

/** The shared wire result for statute and decision identity resolution. */
export const legalResolveResponseSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("resolved"),
    document: legalResolveDocumentSchema,
    otherCourtCandidates: otherCourtCandidatesSchema,
  }),
  v.strictObject({
    status: v.literal("not_found"),
    reason: v.picklist([
      "unknown_document",
      "unknown_section",
      "no_exact_identity",
      "not_at_this_court",
    ]),
    otherCourtCandidates: otherCourtCandidatesSchema,
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
