import { panic, Result } from "better-result";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { parseCaseLawDecisionPath } from "@stll/api-contract/case-law-decision-route";
import { buildSearchHistoryTitle } from "@stll/api-contract/search-history-title";
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

/** The only local-storage read: hand kept entries to the server in one batch. */
export const localHistoryImportEntries = (values: readonly (string | null)[]) =>
  values.flatMap((raw) =>
    readLawRecent(raw).map((entry) => {
      const usedAt = entry.at;
      switch (entry.kind) {
        case "search":
          return { usedAt, entry: { kind: entry.kind, query: entry.query } };
        case "decision": {
          let documentIdentity = entry.documentIdentity;
          if (documentIdentity === undefined) {
            if (entry.courtAbbreviation === null) {
              documentIdentity = { kind: "unknown" };
            } else {
              documentIdentity =
                entry.courtTier === null
                  ? {
                      kind: "decision",
                      courtAbbreviation: entry.courtAbbreviation,
                    }
                  : {
                      kind: "decision",
                      courtAbbreviation: entry.courtAbbreviation,
                      courtTier: entry.courtTier,
                    };
            }
          }
          return {
            usedAt,
            entry: {
              kind: entry.kind,
              documentId: entry.id,
              title: buildSearchHistoryTitle({
                identifier: "",
                description: entry.title,
              }),
              path: entry.path,
              courtId: entry.courtId,
              documentIdentity,
            },
          };
        }
        case "statute": {
          const documentIdentity =
            entry.documentIdentity ??
            (entry.statuteNumber === null || entry.statuteYear === null
              ? { kind: "unknown" as const }
              : {
                  kind: "statute" as const,
                  number: entry.statuteNumber,
                  year: entry.statuteYear,
                });
          return {
            usedAt,
            entry: {
              kind: entry.kind,
              documentId: entry.id,
              title: buildSearchHistoryTitle({
                identifier: "",
                description: entry.title,
              }),
              path: entry.path,
              documentIdentity,
            },
          };
        }
        default:
          entry satisfies never;
          return panic("Unhandled local law history kind");
      }
    }),
  );

type ImportLocalHistoryOptions = {
  storage: Pick<Storage, "getItem" | "removeItem">;
  userKey: string;
  canRemove: () => boolean;
  importEntries: (
    entries: ReturnType<typeof localHistoryImportEntries>,
  ) => Promise<void>;
};

/** Local data is removed only after the whole batch is accepted. */
export const migrateLocalLawHistory = async ({
  storage,
  userKey,
  importEntries,
  canRemove,
}: ImportLocalHistoryOptions) => {
  const keys = [userKey, LAW_HISTORY_STORAGE_KEY];
  const raw = keys.map((key) => storage.getItem(key));
  if (raw.every((value) => value === null)) {
    return;
  }
  await importEntries(localHistoryImportEntries(raw));
  if (!canRemove()) {
    return;
  }
  for (const [index, key] of keys.entries()) {
    if (storage.getItem(key) === raw.at(index)) {
      storage.removeItem(key);
    }
  }
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
