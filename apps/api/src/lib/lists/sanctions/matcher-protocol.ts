import type {
  ParsedList,
  SanctionsEntry,
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

export type SanctionsMatcherMessage =
  | {
      type: "entries";
      source: SanctionsSource;
      editionId: string;
      offset: number;
      entries: SanctionsEntry[];
    }
  | {
      type: "screen";
      source: SanctionsSource;
      editionId: string;
      version: ParsedList["version"] | null;
      query: ScreeningQuery;
      cutoff: number;
      limit: number;
    };

// Plain data only: Result and tagged-error prototypes do not cross threads.
export type SanctionsMatcherReply =
  | { status: "screened"; result: ScreeningResult }
  | { status: "work-limit" }
  | { status: "unavailable" }
  | { status: "entries-loaded" };
