import { Result } from "better-result";
import * as v from "valibot";

import { parseCaseLawDecisionPath } from "@stll/api-contract/case-law-decision-route";
import { parseStatutePath } from "@stll/api-contract/statute-route";
import { Temporal } from "@stll/time";

import { readStoredJson } from "@/lib/stored-json";

// Keep the key so existing owner-scoped searches migrate without a second store.
export const LAW_SEARCH_HISTORY_KEY = "law_search_history";
const RECENT_LIMIT_PER_KIND = 50;
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
const recentEntrySchema = v.variant("kind", [
  v.object({ kind: v.literal("search"), ...legacyEntrySchema.entries }),
  v.object({ kind: v.literal("decision"), ...openedFields }),
  v.object({ kind: v.literal("statute"), ...openedFields }),
]);

export type LawRecentEntry = v.InferOutput<typeof recentEntrySchema>;
export type LawRecentFilter = "all" | LawRecentEntry["kind"];
export const EMPTY_LAW_RECENT: readonly LawRecentEntry[] = [];

export const lawRecentKey = (entry: LawRecentEntry): string =>
  entry.kind === "search"
    ? `${entry.kind}:${entry.query}`
    : `${entry.kind}:${entry.id}`;

export const filterLawRecent = (
  entries: readonly LawRecentEntry[],
  filter: LawRecentFilter,
): readonly LawRecentEntry[] =>
  filter === "all" ? entries : entries.filter((entry) => entry.kind === filter);

export const normalizeRecent = (
  entries: readonly LawRecentEntry[],
): readonly LawRecentEntry[] => {
  const seen = new Set<string>();
  const counts = new Map<LawRecentEntry["kind"], number>();
  return entries
    .toSorted((a, b) => Temporal.Instant.compare(b.at, a.at))
    .filter((entry) => {
      const key = lawRecentKey(entry);
      if (
        seen.has(key) ||
        (counts.get(entry.kind) ?? 0) >= RECENT_LIMIT_PER_KIND
      ) {
        return false;
      }
      seen.add(key);
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
      return true;
    });
};

/** Bad rows are dropped individually; old searches become recent search rows. */
export const readLawRecent = (
  raw: string | null,
): readonly LawRecentEntry[] => {
  const rows = readStoredJson(raw, v.array(v.unknown()));
  if (rows === null) {
    return EMPTY_LAW_RECENT;
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
  return normalizeRecent(entries);
};

/**
 * Takes the entries a browser kept before history was keyed by user into the
 * signed-in user's history: both lists merge, newest first, without
 * duplicates and within the usual cap. `null` when the old entry adds nothing.
 */
export const mergeLawRecent = (
  legacyRaw: string,
  existingRaw: string | null,
): string | null => {
  const legacy = readLawRecent(legacyRaw);
  if (legacy.length === 0) {
    return null;
  }
  return JSON.stringify(
    normalizeRecent([...readLawRecent(existingRaw), ...legacy]),
  );
};
