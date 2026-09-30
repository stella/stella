import type {
  ParsedList,
  SanctionsSource,
  ScreeningQuery,
  ScreeningResult,
} from "@stll/sanctions";

export type SanctionsMatcherRequest = {
  source: SanctionsSource;
  editionId: string;
  list: ParsedList | null;
  query: ScreeningQuery;
  cutoff: number;
  limit: number;
};

// Plain data only: Result and tagged-error prototypes do not cross threads.
export type SanctionsMatcherReply =
  | { status: "screened"; result: ScreeningResult }
  | { status: "unavailable" };
