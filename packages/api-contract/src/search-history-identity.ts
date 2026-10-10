import { panic } from "better-result";

type SearchHistoryIdentity =
  | { kind: "search"; query: string }
  | { kind: "decision" | "statute"; documentId: string };

/** Repeated searches ignore case, canonical Unicode, and whitespace. */
export const searchHistoryEntryMatch = (entry: SearchHistoryIdentity) => {
  switch (entry.kind) {
    case "search":
      return entry.query
        .normalize("NFC")
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
