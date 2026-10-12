import { panic } from "better-result";

import { normalizeUnicode } from "@stll/text-normalize";

type SearchHistoryIdentity =
  | { kind: "search"; query: string }
  | { kind: "decision" | "statute"; documentId: string };

/** Repeated searches ignore case, canonical Unicode, and whitespace. */
export const searchHistoryEntryMatch = (entry: SearchHistoryIdentity) => {
  switch (entry.kind) {
    case "search":
      return normalizeUnicode(entry.query, "NFC")
        .trim()
        .replaceAll(/\s+/gu, " ")
        .toLowerCase();
    case "decision":
    case "statute":
      return entry.documentId.trim();
    default:
      entry satisfies never;
      return panic("Unhandled search history identity");
  }
};
