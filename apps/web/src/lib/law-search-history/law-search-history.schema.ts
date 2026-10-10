import { Result } from "better-result";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { parseCaseLawDecisionPath } from "@stll/api-contract/case-law-decision-route";
import { parseStatutePath } from "@stll/api-contract/statute-route";
import { Temporal } from "@stll/time";

const atSchema = v.pipe(
  v.string(),
  v.check((at) => Result.try(() => Temporal.Instant.from(at)).isOk()),
);
const openedFields = {
  id: v.pipe(v.string(), v.nonEmpty()),
  title: v.pipe(v.string(), v.nonEmpty()),
  // Stored links may only reopen public law pages, never arbitrary URLs.
  path: v.pipe(
    v.string(),
    v.startsWith("/law/"),
    v.regex(/^\/law\/[A-Za-z0-9_/-]+$/u),
    v.check(
      (path) =>
        parseCaseLawDecisionPath(path) !== null ||
        parseStatutePath(path) !== null,
    ),
  ),
  at: atSchema,
};
export const legacyEntrySchema = v.object({
  query: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  at: atSchema,
});
const unknownIdentitySchema = v.object({ kind: v.literal("unknown") });
const decisionIdentitySchema = v.object({
  kind: v.literal("decision"),
  courtAbbreviation: v.nullable(v.string()),
  courtTier: v.optional(v.picklist(COURT_TIER_LABELS)),
});
const statuteIdentitySchema = v.object({
  kind: v.literal("statute"),
  number: v.nullable(v.string()),
  year: v.nullable(v.string()),
});

export const recentEntrySchema = v.variant("kind", [
  v.object({ kind: v.literal("search"), ...legacyEntrySchema.entries }),
  v.object({
    kind: v.literal("decision"),
    ...openedFields,
    documentIdentity: v.optional(
      v.fallback(
        v.variant("kind", [unknownIdentitySchema, decisionIdentitySchema]),
        { kind: "unknown" },
      ),
    ),
    courtId: v.optional(v.nullable(v.string()), null),
    courtAbbreviation: v.optional(v.nullable(v.string()), null),
    courtTier: v.optional(v.nullable(v.picklist(COURT_TIER_LABELS)), null),
  }),
  v.object({
    kind: v.literal("statute"),
    ...openedFields,
    documentIdentity: v.optional(
      v.fallback(
        v.variant("kind", [unknownIdentitySchema, statuteIdentitySchema]),
        { kind: "unknown" },
      ),
    ),
    statuteNumber: v.optional(v.nullable(v.string()), null),
    statuteYear: v.optional(v.nullable(v.string()), null),
  }),
]);

export type LawRecentEntry = v.InferOutput<typeof recentEntrySchema>;
export type LawRecentFilter = "all" | LawRecentEntry["kind"];
