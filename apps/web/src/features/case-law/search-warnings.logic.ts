/**
 * Where the results screen shows what a search answered that the reader did
 * not ask for.
 *
 * The codes are the search contract's; the sentences are not. The response
 * carries an English `message` and `hint` written for an API or agent caller,
 * and this screen never draws them: the code picks translation keys and the
 * reader's own language renders them. The map is total over the codes, so a
 * fourth one cannot land without deciding where it shows.
 */

import { panic } from "better-result";

import type {
  CaseLawSearchWarning,
  CaseLawSearchWarningCode,
} from "@stll/api-contract/search";

import type { TranslationKey } from "@/i18n/types";

/** Where one code shows, and the strings it shows there. */
type CaseLawSearchWarningDisplay =
  /** A muted line above the table: what the search required, and how to require the rest. */
  | {
      surface: "resultsLine";
      messageKey: TranslationKey;
      actionKey: TranslationKey;
    }
  /** In place of the rows: why there are none, and what to try instead. */
  | {
      surface: "emptyState";
      messageKey: TranslationKey;
      hintKey: TranslationKey;
    };

const CASE_LAW_SEARCH_WARNING_DISPLAY = {
  function_words_optional: {
    surface: "resultsLine",
    messageKey: "caseLaw.searchWarnings.resultsFor",
    actionKey: "caseLaw.searchWarnings.searchEveryWord",
  },
  no_hits: {
    surface: "emptyState",
    messageKey: "caseLaw.searchWarnings.noHits.message",
    hintKey: "caseLaw.searchWarnings.noHits.hint",
  },
  no_hits_filtered: {
    surface: "emptyState",
    messageKey: "caseLaw.searchWarnings.noHitsFiltered.message",
    hintKey: "caseLaw.searchWarnings.noHitsFiltered.hint",
  },
} as const satisfies Record<
  CaseLawSearchWarningCode,
  CaseLawSearchWarningDisplay
>;

type WarningDisplay =
  (typeof CASE_LAW_SEARCH_WARNING_DISPLAY)[CaseLawSearchWarningCode];

/** The line above the table, with the query it names. */
export type CaseLawResultsLine = Extract<
  WarningDisplay,
  { surface: "resultsLine" }
> & {
  /** The query the search answered, which is not the one the URL asked for. */
  query: string;
};

/** What stands where the rows would be. */
export type CaseLawEmptyState = Extract<
  WarningDisplay,
  { surface: "emptyState" }
>;

/** What a search reported about itself, beside the hits it found. */
export type CaseLawSearchAnswer = {
  /** The query the engine actually answered. */
  queryUsed: string;
  warnings: readonly CaseLawSearchWarning[];
};

export type CaseLawWarningSurfaces = {
  /** Null while nothing was dropped, and for a listing that answers no query. */
  resultsLine: CaseLawResultsLine | null;
  /** Null while something matched; the plain "no results" line stands then. */
  emptyState: CaseLawEmptyState | null;
};

/**
 * The two regions a search's warnings can reach, read from one answer.
 *
 * Null in means a listing rather than a search — a browse page answers no
 * query, so there is nothing it could have required less of — and the same
 * for a page whose rows have not arrived yet.
 */
export const caseLawWarningSurfaces = (
  answered: CaseLawSearchAnswer | null,
): CaseLawWarningSurfaces => {
  let resultsLine: CaseLawResultsLine | null = null;
  let emptyState: CaseLawEmptyState | null = null;
  if (answered === null) {
    return { emptyState, resultsLine };
  }
  for (const { code } of answered.warnings) {
    const display = CASE_LAW_SEARCH_WARNING_DISPLAY[code];
    switch (display.surface) {
      case "resultsLine":
        resultsLine = {
          actionKey: display.actionKey,
          messageKey: display.messageKey,
          query: answered.queryUsed,
          surface: display.surface,
        };
        break;
      case "emptyState":
        emptyState = {
          hintKey: display.hintKey,
          messageKey: display.messageKey,
          surface: display.surface,
        };
        break;
      default:
        display satisfies never;
        return panic(`Unhandled case-law search warning: ${code}`);
    }
  }
  return { emptyState, resultsLine };
};
