import { panic } from "better-result";

import type { CaseLawSearchFilter } from "@stll/api-contract/search";
import { normalizeUnicode } from "@stll/text-normalize";

import type { searchView } from "../case-law-results/model";
import type { AppMessageKey, appLocale } from "./locale";

type SearchPage = Extract<ReturnType<typeof searchView>, { type: "search" }>;
export type AppSearchWarning =
  SearchPage["searches"][number]["warnings"][number];

const FILTER_LABELS = {
  court: "court",
  courts: "court",
  category: "filterCategory",
  hasLegalSentence: "filterLegalSentence",
  dateFrom: "from",
  dateTo: "to",
  decisionType: "filterType",
  language: "filterLanguage",
  sourceId: "filterSource",
} as const satisfies Record<CaseLawSearchFilter, AppMessageKey>;

// The app reads only codes and structured values, never model instructions.
export const searchNoticeDetails = (
  warnings: readonly AppSearchWarning[],
  t: ReturnType<typeof appLocale>["t"],
) => {
  const aliases = new Map<string, { input: string; resolved: string }>();
  const words = new Map<string, string>();
  const filters = new Set<CaseLawSearchFilter>();
  const dropped = new Set<string>();
  let noHits = false;
  for (const warning of warnings) {
    switch (warning.code) {
      case "filter_read":
        if (warning.filter === "court") {
          for (const pair of warning.courtAliases) {
            aliases.set(JSON.stringify([pair.input, pair.resolved]), pair);
          }
        }
        break;
      case "function_words_optional":
        for (const word of warning.droppedFunctionWords) {
          words.set(normalizeUnicode(word, "NFC").toLowerCase(), word);
        }
        break;
      case "no_hits_filtered":
        for (const filter of warning.filters) {
          filters.add(filter);
        }
        break;
      case "filter_dropped":
        if (warning.filter === "court") {
          dropped.add(warning.received);
        }
        break;
      case "no_hits":
        noHits = true;
        break;
      case "many_required_terms":
        break;
      default:
        panic("Unknown app search warning", warning satisfies never);
    }
  }
  const details: string[] = [];
  if (aliases.size > 0) {
    details.push(
      t("noticeAliases", {
        values: [...aliases.values()]
          .map(({ input, resolved }) =>
            t("noticeAliasPair", { input, resolved }),
          )
          .join(", "),
      }),
    );
  }
  if (words.size > 0) {
    details.push(t("noticeWords", { values: [...words.values()].join(", ") }));
  }
  if (dropped.size > 0) {
    details.push(t("noticeDroppedFilter", { values: [...dropped].join(", ") }));
  }
  if (filters.size > 0) {
    details.push(
      t("noticeFilters", {
        values: [
          ...new Set([...filters].map((filter) => t(FILTER_LABELS[filter]))),
        ].join(", "),
      }),
    );
  }
  if (noHits) {
    details.push(t("noticeNoHits"));
  }
  return details;
};
