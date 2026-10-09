import * as v from "valibot";

const legalResolveCandidateSchema = v.strictObject({
  identifier: v.string(),
  label: v.string(),
  url: v.optional(v.string()),
});

const legalResolveDocumentIdentitySchema = {
  identifier: v.string(),
  country: v.string(),
  metadata: v.record(v.string(), v.unknown()),
};

const legalResolveDocumentSchema = v.union([
  v.strictObject({
    ...legalResolveDocumentIdentitySchema,
    blocks: v.optional(v.array(v.unknown())),
    text: v.optional(v.string()),
  }),
  v.strictObject({
    ...legalResolveDocumentIdentitySchema,
    textWithheld: v.literal("licence"),
  }),
]);

/** The shared wire result for statute and decision identity resolution. */
export const legalResolveResponseSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("resolved"),
    document: legalResolveDocumentSchema,
  }),
  v.strictObject({
    status: v.literal("not_found"),
    reason: v.picklist([
      "unknown_document",
      "unknown_section",
      "no_exact_identity",
    ]),
  }),
  v.strictObject({
    status: v.literal("ambiguous"),
    candidates: v.array(legalResolveCandidateSchema),
  }),
  v.strictObject({
    status: v.literal("incomplete_identifier"),
    missing: v.array(v.string()),
  }),
  v.strictObject({ status: v.literal("country_unavailable") }),
]);

export type LegalResolveResponse = v.InferOutput<
  typeof legalResolveResponseSchema
>;
