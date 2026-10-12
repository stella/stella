import { Result } from "better-result";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { parseCaseLawDecisionPath } from "@stll/api-contract/case-law-decision-route";
import { parseStatutePath } from "@stll/api-contract/statute-route";
import { Temporal } from "@stll/time";

import { readStoredJson } from "@/lib/stored-json";

// Keep the key so existing owner-scoped searches migrate without a second store.
export const LAW_HISTORY_STORAGE_KEY = "law_search_history";
// A display limit only; the server retains entries until their owner deletes them.
export const LAW_HISTORY_DISPLAY_LIMIT = 20;
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
const legacyEntrySchema = v.object({
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

const recentEntrySchema = v.variant("kind", [
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
const EMPTY: readonly LawRecentEntry[] = [];

/** Bad rows are dropped individually; old searches become recent search rows. */
export const readLawRecent = (
  raw: string | null,
): readonly LawRecentEntry[] => {
  const rows = readStoredJson(raw, v.array(v.unknown()));
  if (rows === null) {
    return EMPTY;
  }
  const entries: LawRecentEntry[] = [];
  for (const row of rows) {
    const recent = v.safeParse(recentEntrySchema, row);
    if (recent.success) {
      entries.push(recent.output);
      continue;
    }
    // Only rows without a discriminator belong to the old search format.
    if (typeof row !== "object" || row === null || "kind" in row) {
      continue;
    }
    const legacy = v.safeParse(legacyEntrySchema, row);
    if (legacy.success) {
      entries.push({ kind: "search", ...legacy.output });
    }
  }
  return entries;
};

export const lawRecentKey = (entry: LawRecentEntry): string =>
  entry.kind === "search"
    ? `${entry.kind}:${entry.query}`
    : `${entry.kind}:${entry.id}`;

/** Preserve every local entry until the server accepts the import. */
export const mergeLawRecent = (
  legacyRaw: string,
  existingRaw: string | null,
): string | null => {
  const legacy = readLawRecent(legacyRaw);
  if (legacy.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  const merged = [...readLawRecent(existingRaw), ...legacy]
    .toSorted((a, b) => Temporal.Instant.compare(b.at, a.at))
    .filter((entry) => {
      const key = lawRecentKey(entry);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  return JSON.stringify(merged);
};
