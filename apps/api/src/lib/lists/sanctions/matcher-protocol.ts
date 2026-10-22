import type {
  ParsedList,
  SanctionsEntry,
  SanctionsSource,
  ScreeningQuery,
  ScreeningResult,
  ScreeningWorkUsage,
} from "@stll/sanctions";

export type SanctionsMatcherRequest = {
  source: SanctionsSource;
  editionId: string;
  list: ParsedList | null;
  query: ScreeningQuery;
  cutoff: number;
  limit: number;
  maxWork?: number;
};

/** One edition to index ahead of screening: its entries, then its version. */
export type SanctionsMatcherLoad = {
  source: SanctionsSource;
  editionId: string;
  list: ParsedList;
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
      type: "index";
      source: SanctionsSource;
      editionId: string;
      version: ParsedList["version"];
    }
  | {
      type: "screen";
      source: SanctionsSource;
      editionId: string;
      version: ParsedList["version"] | null;
      query: ScreeningQuery;
      cutoff: number;
      limit: number;
      maxWork?: number;
    };

// Plain data only: Result and tagged-error prototypes do not cross threads.
export type SanctionsMatcherReply =
  | { status: "screened"; result: ScreeningResult; work: ScreeningWorkUsage }
  | { status: "work-limit" }
  | { status: "unavailable" }
  | { status: "entries-loaded" }
  | { status: "indexed" };
