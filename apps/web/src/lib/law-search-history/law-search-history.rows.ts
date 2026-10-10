import * as v from "valibot";

import {
  legacyEntrySchema,
  recentEntrySchema,
} from "@/lib/law-search-history/law-search-history.schema";
import type { LawRecentEntry } from "@/lib/law-search-history/law-search-history.schema";
import { readStoredJson } from "@/lib/stored-json";

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
