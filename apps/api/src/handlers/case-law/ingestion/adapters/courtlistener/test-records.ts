/**
 * Synthetic CourtListener records for tests, shaped by the pinned snapshot
 * headers. Every column is present; values not set by a test are blank, as
 * the CSV decoder yields an empty column.
 */

import { panic } from "better-result";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { admitCourtListenerRecord } from "./record";
import {
  CITATION_COLUMNS,
  CLUSTER_COLUMNS,
  COURT_COLUMNS,
  type CsvRow,
  DOCKET_COLUMNS,
  isCsvRow,
  OPINION_COLUMNS,
  PERSON_COLUMNS,
} from "./snapshot-columns";

const row = <TColumn extends string>(
  columns: readonly TColumn[],
  values: Readonly<Record<string, string | undefined>>,
): CsvRow<TColumn> => {
  const built = Object.fromEntries(
    columns.map((column) => [column, values[column] ?? ""] as const),
  );
  return isCsvRow(columns)(built) ? built : panic("test row lost a column");
};

export const clusterRow = (
  values: Partial<Record<(typeof CLUSTER_COLUMNS)[number], string>> = {},
) =>
  row(CLUSTER_COLUMNS, {
    id: "9114912",
    docket_id: "66381192",
    date_filed: "1991-11-12",
    date_filed_is_approximate: "f",
    slug: "daniels-v-borg",
    case_name: "Daniels v. Borg",
    precedential_status: "Published",
    blocked: "f",
    ...values,
  });

export const docketRow = (
  values: Partial<Record<(typeof DOCKET_COLUMNS)[number], string>> = {},
) =>
  row(DOCKET_COLUMNS, {
    id: "66381192",
    court_id: "scotus",
    docket_number: "No. 91-5746",
    blocked: "f",
    ...values,
  });

export const courtRow = (
  values: Partial<Record<(typeof COURT_COLUMNS)[number], string>> = {},
) =>
  row(COURT_COLUMNS, {
    id: "scotus",
    short_name: "Supreme Court",
    full_name: "Supreme Court of the United States",
    citation_string: "SCOTUS",
    ...values,
  });

export const opinionRow = (
  values: Partial<Record<(typeof OPINION_COLUMNS)[number], string>> = {},
) =>
  row(OPINION_COLUMNS, {
    id: "9109419",
    cluster_id: "9114912",
    type: "020lead",
    per_curiam: "f",
    extracted_by_ocr: "f",
    xml_harvard:
      '<opinion type="majority">\n<p id="AmFn">C. A. 9th Cir. Certiorari denied.</p>\n</opinion>',
    ...values,
  });

export const citationRow = (
  values: Partial<Record<(typeof CITATION_COLUMNS)[number], string>> = {},
) =>
  row(CITATION_COLUMNS, {
    id: "13946562",
    volume: "502",
    reporter: "U.S.",
    page: "959",
    type: "1",
    cluster_id: "9114912",
    ...values,
  });

export const personRow = (
  values: Partial<Record<(typeof PERSON_COLUMNS)[number], string>> = {},
) =>
  row(PERSON_COLUMNS, {
    id: "3045",
    name_first: "Byron",
    name_middle: "Raymond",
    name_last: "White",
    ...values,
  });

type RecordParts = {
  cluster?: ReturnType<typeof clusterRow>;
  docket?: ReturnType<typeof docketRow>;
  court?: ReturnType<typeof courtRow>;
  opinions?: ReturnType<typeof opinionRow>[];
  citations?: ReturnType<typeof citationRow>[];
  judgeRelations?:
    | { status: "unavailable" }
    | {
        status: "complete";
        people: ReturnType<typeof personRow>[];
        joinedBy: { opinionId: string; personId: string }[];
      };
};

/** A complete SCOTUS certiorari-denial record; parts override the defaults. */
export const courtListenerRecord = (parts: RecordParts = {}) => {
  const opinions = parts.opinions ?? [opinionRow()];
  return {
    version: 1,
    cluster: parts.cluster ?? clusterRow(),
    docket: parts.docket ?? docketRow(),
    court: parts.court ?? courtRow(),
    opinions,
    citations: parts.citations ?? [citationRow()],
    judgeRelations: parts.judgeRelations ?? { status: "unavailable" },
    provenance: {
      snapshot: "2026-06-30",
      artifacts: [
        {
          table: "opinions",
          url: "https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/opinions-2026-06-30.csv.bz2",
          etag: '"150e073ae1e7adad94ca9a57fb449980-6505"',
        },
      ],
      expectedOpinionIds: opinions.map(({ id }) => id),
      citationCoverage: "complete",
    },
  };
};

/**
 * Recorded snapshot clusters: whole rows of the pinned tables, assembled into
 * records. Their provenance sidecar names the source files and extraction.
 */
export const recordedClusters = () =>
  gunzipSync(
    readFileSync(
      new URL(
        "../__fixtures__/courtlistener-clusters-2026-06-30.ndjson.gz",
        import.meta.url,
      ),
    ),
  )
    .toString("utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map(
      (line) =>
        admitCourtListenerRecord(JSON.parse(line)).unwrap(
          "the committed fixture holds only admissible records",
        ).record,
    );
