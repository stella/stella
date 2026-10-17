import { Result } from "better-result";
import * as v from "valibot";

import {
  legacyEntrySchema,
  recentEntrySchema,
} from "@/lib/law-search-history/law-search-history.schema";
import type { LawRecentEntry } from "@/lib/law-search-history/law-search-history.schema";

const EMPTY: readonly LawRecentEntry[] = [];

/** Bad rows are dropped individually; old searches become recent search rows. */
export const readLawRecent = (
  raw: string | null,
): readonly LawRecentEntry[] => {
  const decoded = Result.try((): unknown => JSON.parse(raw ?? "null"));
  if (Result.isError(decoded)) {
    return EMPTY;
  }
  const parsed = v.safeParse(v.array(v.unknown()), decoded.value);
  if (!parsed.success) {
    return EMPTY;
  }
  const entries: LawRecentEntry[] = [];
  for (const row of parsed.output) {
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
