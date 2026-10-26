import { panic } from "better-result";

import { normalizeUnicode } from "@stll/text-normalize";

import { parseCaseLawDecisionPath } from "./case-law-decision-route";
import { isPublicCountry } from "./public-country-capability";
import type { PublicCountry } from "./public-country-capability";
import { parseStatutePath } from "./statute-route";

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

/** The country whose law page a recorded decision or statute path opens. */
export const searchHistoryPathJurisdiction = (
  path: string,
): PublicCountry | null => {
  const country = (
    parseCaseLawDecisionPath(path) ?? parseStatutePath(path)
  )?.country.toUpperCase();
  return country !== undefined && isPublicCountry(country) ? country : null;
};
