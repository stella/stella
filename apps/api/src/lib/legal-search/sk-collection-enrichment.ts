import { TaggedError } from "better-result";
import type { Result } from "better-result";

import type { RawIngestionResult } from "@/api/lib/legal-search/ingestion-types";

export const SK_COLLECTION_PARSER_VERSION = 4;

export const SK_COLLECTION_SERIES = {
  NS_R: "ns-r",
  NSS_ZNSS: "nss-znss",
} as const;

export type SkCollectionSeries =
  (typeof SK_COLLECTION_SERIES)[keyof typeof SK_COLLECTION_SERIES];

export type SkCollectionIssue = {
  series: SkCollectionSeries;
  year: number;
  url: string;
};

/** The complete persistence allowlist; no issue bytes or surrounding prose. */
type SkCollectionAnnotation = {
  series: SkCollectionSeries;
  statedNumber: string;
  publicationYear: number;
  legalSentence: string;
  source: { issueUrl: string; page: number };
};

/** These identifiers are transient join input, never a correction to a row. */
export type SkCollectionRecord = {
  annotation: SkCollectionAnnotation;
  target: {
    court: string;
    docket: string;
    ecli: string | null;
    decisionDate: string | null;
  };
};

export type SkCollectionDefect =
  | { type: "needs-ocr"; page: number; statedNumber: string }
  | { type: "unreadable-entry"; page: number; statedNumber: string }
  | { type: "duplicate-number"; page: number; statedNumber: string }
  | { type: "number-year-conflict"; page: number; statedNumber: string };

export type SkCollectionParseOutcome =
  | { status: "parsed"; records: readonly SkCollectionRecord[] }
  | {
      status: "partial";
      records: readonly SkCollectionRecord[];
      defects: readonly SkCollectionDefect[];
    }
  | { status: "needs-ocr"; reason: "before-2010" | "image-only" }
  | { status: "defective"; defects: readonly SkCollectionDefect[] };

/** Persist this small parsed snapshot, never the fetched PDF or its full text. */
export type SkCollectionIssueCache = {
  issue: SkCollectionIssue;
  parserVersion: number;
  etag: string | null;
  lastModified: string | null;
  outcome: SkCollectionParseOutcome;
};

export type SkCollectionReadOutcome =
  | { status: "disabled" }
  | { status: "robots-denied"; issueUrl: string }
  | { status: "unchanged"; cache: SkCollectionIssueCache }
  | { status: "read"; cache: SkCollectionIssueCache };

export type SkCollectionDecision = Pick<
  RawIngestionResult,
  "caseNumber" | "court" | "country"
> & { id: string; ecli: string | null; decisionDate: string | null };

export type SkCollectionJoinOutcome =
  | {
      status: "matched";
      decisionId: string;
      annotation: SkCollectionAnnotation;
    }
  | { status: "unmatched"; record: SkCollectionRecord }
  | {
      status: "ambiguous";
      record: SkCollectionRecord;
      decisionIds: readonly string[];
    };

export class SkCollectionIssueError extends TaggedError(
  "SkCollectionIssueError",
)<{
  message: string;
  issueUrl: string;
  cause?: unknown;
}> {}

export type SkCollectionReadOptions = {
  issue: SkCollectionIssue;
  /** Durable parsed cache supplied by the caller, not an in-process byte cache. */
  cache: SkCollectionIssueCache | null;
  signal?: AbortSignal | undefined;
};

export type SkCollectionConnector = {
  status: "disabled" | "enabled";
  readIssue: (
    options: SkCollectionReadOptions,
  ) => Promise<Result<SkCollectionReadOutcome, SkCollectionIssueError>>;
  join: (
    records: readonly SkCollectionRecord[],
    decisions: readonly SkCollectionDecision[],
  ) => readonly SkCollectionJoinOutcome[];
};
