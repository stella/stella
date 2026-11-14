// parser-output-unchanged: source-exclusion-contract: Publisher schemas, raw retention and coverage checks do not change parsed decision projections.
// parser-output-unchanged: [us-courtlistener] canonical ID helpers and OpinionRow moved to parser modules; output is identical.
/**
 * The CourtListener bulk CSV columns of the pinned 2026-06-30 snapshot, one
 * map per table in header order, each column with what becomes of it.
 *
 * The pinned headers declare the publisher records independently of their
 * disposition maps. Admitting a new column requires a map entry at compile
 * time; removing an entry cannot silently narrow the accepted row. A column
 * excluded here is still kept in the stored raw; exclusion says only that the
 * decision row does not carry it.
 */

import { compareCanonicalIds } from "@/api/handlers/case-law/ingestion/parsers/courtlistener/canonical-id-order";
import type { OpinionRow } from "@/api/handlers/case-law/ingestion/parsers/courtlistener/opinion-row";
import {
  legacyExcludedSourceField,
  type SourceFieldDisposition,
} from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";

export {
  compareBytewise,
  compareCanonicalIds,
} from "@/api/handlers/case-law/ingestion/parsers/courtlistener/canonical-id-order";

type ResultKey =
  | "identifiers"
  | "courtId"
  | "decisionDate"
  | "sourceUrl"
  | "documentUrl"
  | "judges";

const meta = (key: string): SourceFieldDisposition => ({
  disposition: "stored",
  target: { type: "metadata", key },
});
const result = (key: ResultKey): SourceFieldDisposition => ({
  disposition: "stored",
  target: { type: "result", key },
});
const text = (
  key: "abstract" | "headnote" | "summary",
): SourceFieldDisposition => ({
  disposition: "stored",
  target: { type: "textField", key },
});
const DOCUMENT: SourceFieldDisposition = {
  disposition: "stored",
  target: { type: "document" },
};

const TIMESTAMP = legacyExcludedSourceField(
  "publisher record-keeping timestamp, not a date the decision states",
);
const JOIN_KEY = legacyExcludedSourceField(
  "join key to a parent row, verified equal on admission",
);
const FILE_PATH = legacyExcludedSourceField(
  "storage or archive path of a file this record does not fetch",
);
const TRIAL = legacyExcludedSourceField(
  "trial-docket administration data the decision does not state",
);
const ASSIGNED = legacyExcludedSourceField(
  "trial-level judge assignment; judges come from opinion attribution",
);
const DIRECTORY = legacyExcludedSourceField(
  "court directory attribute; the generated directory owns court identity",
);
const BIO = legacyExcludedSourceField(
  "biographical data; the decision states only who wrote or joined",
);
const RESTATED = legacyExcludedSourceField(
  "restates the cluster's case name or slug, which are stored",
);
const BINARY = legacyExcludedSourceField(
  "attribute of the binary rendition, which this record does not fetch",
);
const DOCKET_BLOCK = legacyExcludedSourceField(
  "the cluster's blocking state is stored; the docket's serves admission",
);

/** `opinion-clusters-2026-06-30.csv` */
export const CLUSTER_COLUMNS = [
  "id",
  "date_created",
  "date_modified",
  "judges",
  "date_filed",
  "date_filed_is_approximate",
  "slug",
  "case_name_short",
  "case_name",
  "case_name_full",
  "scdb_id",
  "scdb_decision_direction",
  "scdb_votes_majority",
  "scdb_votes_minority",
  "source",
  "procedural_history",
  "attorneys",
  "nature_of_suit",
  "posture",
  "syllabus",
  "headnotes",
  "summary",
  "disposition",
  "history",
  "other_dates",
  "cross_reference",
  "correction",
  "citation_count",
  "precedential_status",
  "date_blocked",
  "blocked",
  "filepath_json_harvard",
  "filepath_pdf_harvard",
  "docket_id",
  "arguments",
  "headmatter",
] as const;

type ClusterPublisherRecord = CsvRow<(typeof CLUSTER_COLUMNS)[number]>;

export const CLUSTER_FIELDS = {
  id: { disposition: "stored", target: { type: "identity" } },
  date_created: TIMESTAMP,
  date_modified: TIMESTAMP,
  judges: meta("benchAsPrinted"),
  date_filed: result("decisionDate"),
  date_filed_is_approximate: meta("dateFiled"),
  slug: result("sourceUrl"),
  case_name_short: meta("caseNameShort"),
  case_name: meta("caseName"),
  case_name_full: meta("caseNameFull"),
  scdb_id: meta("scdb"),
  scdb_decision_direction: meta("scdb"),
  scdb_votes_majority: meta("scdb"),
  scdb_votes_minority: meta("scdb"),
  source: meta("publisherSource"),
  procedural_history: meta("proceduralHistory"),
  attorneys: meta("attorneys"),
  nature_of_suit: meta("natureOfSuit"),
  posture: meta("posture"),
  syllabus: text("abstract"),
  headnotes: text("headnote"),
  summary: text("summary"),
  disposition: meta("disposition"),
  history: meta("history"),
  other_dates: meta("otherDates"),
  cross_reference: meta("crossReference"),
  correction: meta("correction"),
  citation_count: legacyExcludedSourceField(
    "count of citing decisions at export time, not read as treatment",
  ),
  precedential_status: meta("precedentialStatus"),
  date_blocked: meta("publisherBlocked"),
  blocked: meta("publisherBlocked"),
  filepath_json_harvard: FILE_PATH,
  filepath_pdf_harvard: FILE_PATH,
  docket_id: JOIN_KEY,
  arguments: DOCUMENT,
  headmatter: DOCUMENT,
} as const satisfies Record<
  keyof ClusterPublisherRecord,
  SourceFieldDisposition
>;

/** `dockets-2026-06-30.csv` */
export const DOCKET_COLUMNS = [
  "id",
  "date_created",
  "date_modified",
  "source",
  "appeal_from_str",
  "assigned_to_str",
  "referred_to_str",
  "panel_str",
  "date_last_index",
  "date_cert_granted",
  "date_cert_denied",
  "date_argued",
  "date_reargued",
  "date_reargument_denied",
  "date_filed",
  "date_terminated",
  "date_last_filing",
  "case_name_short",
  "case_name",
  "case_name_full",
  "slug",
  "docket_number",
  "docket_number_core",
  "pacer_case_id",
  "cause",
  "nature_of_suit",
  "jury_demand",
  "jurisdiction_type",
  "appellate_fee_status",
  "appellate_case_type_information",
  "mdl_status",
  "filepath_local",
  "filepath_ia",
  "filepath_ia_json",
  "ia_upload_failure_count",
  "ia_needs_upload",
  "ia_date_first_change",
  "view_count",
  "date_blocked",
  "blocked",
  "appeal_from_id",
  "assigned_to_id",
  "court_id",
  "idb_data_id",
  "originating_court_information_id",
  "referred_to_id",
  "federal_dn_case_type",
  "federal_dn_office_code",
  "federal_dn_judge_initials_assigned",
  "federal_dn_judge_initials_referred",
  "federal_defendant_number",
  "parent_docket_id",
  "docket_number_raw",
  "docket_number_source",
] as const;

type DocketPublisherRecord = CsvRow<(typeof DOCKET_COLUMNS)[number]>;

export const DOCKET_FIELDS = {
  id: meta("courtListener"),
  date_created: TIMESTAMP,
  date_modified: TIMESTAMP,
  source: legacyExcludedSourceField(
    "publisher code for how it acquired the docket",
  ),
  appeal_from_str: meta("appealFrom"),
  assigned_to_str: ASSIGNED,
  referred_to_str: ASSIGNED,
  panel_str: ASSIGNED,
  date_last_index: TIMESTAMP,
  date_cert_granted: meta("docketDates"),
  date_cert_denied: meta("docketDates"),
  date_argued: meta("docketDates"),
  date_reargued: meta("docketDates"),
  date_reargument_denied: meta("docketDates"),
  date_filed: meta("docketDates"),
  date_terminated: meta("docketDates"),
  date_last_filing: TIMESTAMP,
  case_name_short: RESTATED,
  case_name: RESTATED,
  case_name_full: RESTATED,
  slug: RESTATED,
  docket_number: result("identifiers"),
  docket_number_core: meta("docketNumberCore"),
  pacer_case_id: TRIAL,
  cause: TRIAL,
  nature_of_suit: TRIAL,
  jury_demand: TRIAL,
  jurisdiction_type: TRIAL,
  appellate_fee_status: TRIAL,
  appellate_case_type_information: TRIAL,
  mdl_status: TRIAL,
  filepath_local: FILE_PATH,
  filepath_ia: FILE_PATH,
  filepath_ia_json: FILE_PATH,
  ia_upload_failure_count: TIMESTAMP,
  ia_needs_upload: TIMESTAMP,
  ia_date_first_change: TIMESTAMP,
  view_count: legacyExcludedSourceField(
    "page-view counter of the publisher's site",
  ),
  date_blocked: DOCKET_BLOCK,
  blocked: DOCKET_BLOCK,
  appeal_from_id: legacyExcludedSourceField(
    "directory ID of the court below; appealFrom keeps its printed name",
  ),
  assigned_to_id: ASSIGNED,
  court_id: result("courtId"),
  idb_data_id: TRIAL,
  originating_court_information_id: TRIAL,
  referred_to_id: ASSIGNED,
  federal_dn_case_type: TRIAL,
  federal_dn_office_code: TRIAL,
  federal_dn_judge_initials_assigned: TRIAL,
  federal_dn_judge_initials_referred: TRIAL,
  federal_defendant_number: TRIAL,
  parent_docket_id: TRIAL,
  docket_number_raw: meta("docketNumberRaw"),
  docket_number_source: TRIAL,
} as const satisfies Record<
  keyof DocketPublisherRecord,
  SourceFieldDisposition
>;

/** `courts-2026-06-30.csv` */
export const COURT_COLUMNS = [
  "id",
  "pacer_court_id",
  "pacer_has_rss_feed",
  "pacer_rss_entry_types",
  "date_last_pacer_contact",
  "fjc_court_id",
  "date_modified",
  "in_use",
  "has_opinion_scraper",
  "has_oral_argument_scraper",
  "position",
  "citation_string",
  "short_name",
  "full_name",
  "url",
  "start_date",
  "end_date",
  "jurisdiction",
  "notes",
  "parent_court_id",
] as const;

type CourtPublisherRecord = CsvRow<(typeof COURT_COLUMNS)[number]>;

export const COURT_FIELDS = {
  id: result("courtId"),
  pacer_court_id: DIRECTORY,
  pacer_has_rss_feed: DIRECTORY,
  pacer_rss_entry_types: DIRECTORY,
  date_last_pacer_contact: TIMESTAMP,
  fjc_court_id: DIRECTORY,
  date_modified: TIMESTAMP,
  in_use: DIRECTORY,
  has_opinion_scraper: DIRECTORY,
  has_oral_argument_scraper: DIRECTORY,
  position: DIRECTORY,
  citation_string: meta("publisherCourt"),
  short_name: meta("publisherCourt"),
  full_name: meta("publisherCourt"),
  url: DIRECTORY,
  start_date: DIRECTORY,
  end_date: DIRECTORY,
  jurisdiction: DIRECTORY,
  notes: DIRECTORY,
  parent_court_id: DIRECTORY,
} as const satisfies Record<keyof CourtPublisherRecord, SourceFieldDisposition>;

/** `opinions-2026-06-30.csv` */
export const OPINION_COLUMNS = [
  "id",
  "date_created",
  "date_modified",
  "author_str",
  "per_curiam",
  "joined_by_str",
  "type",
  "sha1",
  "page_count",
  "download_url",
  "local_path",
  "plain_text",
  "html",
  "html_lawbox",
  "html_columbia",
  "html_anon_2020",
  "xml_harvard",
  "xml_scan",
  "html_with_citations",
  "extracted_by_ocr",
  "author_id",
  "cluster_id",
] as const;

type OpinionPublisherRecord = OpinionRow &
  CsvRow<(typeof OPINION_COLUMNS)[number]>;

export const OPINION_FIELDS = {
  id: meta("courtListener"),
  date_created: TIMESTAMP,
  date_modified: TIMESTAMP,
  author_str: result("judges"),
  per_curiam: meta("opinionAttribution"),
  joined_by_str: meta("judgeAttribution"),
  type: meta("opinionAttribution"),
  sha1: BINARY,
  page_count: BINARY,
  download_url: result("documentUrl"),
  local_path: FILE_PATH,
  plain_text: DOCUMENT,
  html: DOCUMENT,
  html_lawbox: DOCUMENT,
  html_columbia: DOCUMENT,
  html_anon_2020: DOCUMENT,
  xml_harvard: DOCUMENT,
  xml_scan: legacyExcludedSourceField(
    "scan-layout XML needing page images; a record with only it is held",
  ),
  html_with_citations: DOCUMENT,
  extracted_by_ocr: meta("ocr"),
  author_id: result("judges"),
  cluster_id: JOIN_KEY,
} as const satisfies Record<
  keyof OpinionPublisherRecord,
  SourceFieldDisposition
>;

/** `citations-2026-06-30.csv` */
export const CITATION_COLUMNS = [
  "id",
  "volume",
  "reporter",
  "page",
  "type",
  "cluster_id",
  "date_created",
  "date_modified",
] as const;

type CitationPublisherRecord = CsvRow<(typeof CITATION_COLUMNS)[number]>;

export const CITATION_FIELDS = {
  id: legacyExcludedSourceField("row key; it orders tuples that tie"),
  volume: result("identifiers"),
  reporter: result("identifiers"),
  page: result("identifiers"),
  type: result("identifiers"),
  cluster_id: JOIN_KEY,
  date_created: TIMESTAMP,
  date_modified: TIMESTAMP,
} as const satisfies Record<
  keyof CitationPublisherRecord,
  SourceFieldDisposition
>;

/** `people-db-people-2026-06-30.csv`, where judge relations are supplied. */
export const PERSON_COLUMNS = [
  "id",
  "date_created",
  "date_modified",
  "date_completed",
  "fjc_id",
  "slug",
  "name_first",
  "name_middle",
  "name_last",
  "name_suffix",
  "date_dob",
  "date_granularity_dob",
  "date_dod",
  "date_granularity_dod",
  "dob_city",
  "dob_state",
  "dob_country",
  "dod_city",
  "dod_state",
  "dod_country",
  "gender",
  "religion",
  "ftm_total_received",
  "ftm_eid",
  "has_photo",
  "is_alias_of_id",
] as const;

type PersonPublisherRecord = CsvRow<(typeof PERSON_COLUMNS)[number]>;

export const PERSON_FIELDS = {
  id: JOIN_KEY,
  date_created: TIMESTAMP,
  date_modified: TIMESTAMP,
  date_completed: TIMESTAMP,
  fjc_id: BIO,
  slug: BIO,
  name_first: result("judges"),
  name_middle: result("judges"),
  name_last: result("judges"),
  name_suffix: result("judges"),
  date_dob: BIO,
  date_granularity_dob: BIO,
  date_dod: BIO,
  date_granularity_dod: BIO,
  dob_city: BIO,
  dob_state: BIO,
  dob_country: BIO,
  dod_city: BIO,
  dod_state: BIO,
  dod_country: BIO,
  gender: BIO,
  religion: BIO,
  ftm_total_received: BIO,
  ftm_eid: BIO,
  has_photo: BIO,
  is_alias_of_id: BIO,
} as const satisfies Record<
  keyof PersonPublisherRecord,
  SourceFieldDisposition
>;

/** One CSV row: every pinned column, as the decoder produced its text. */
export type CsvRow<TColumn extends string> = Readonly<Record<TColumn, string>>;

export type { OpinionRow } from "@/api/handlers/case-law/ingestion/parsers/courtlistener/opinion-row";
export type CitationRow = CsvRow<(typeof CITATION_COLUMNS)[number]>;
export type PersonRow = CsvRow<(typeof PERSON_COLUMNS)[number]>;

/** Whether `input` holds exactly `columns`, each a string. */
export const isCsvRow =
  <TColumn extends string>(columns: readonly TColumn[]) =>
  (input: unknown): input is CsvRow<TColumn> =>
    isRecord(input) &&
    Object.keys(input).length === columns.length &&
    columns.every(
      (column) =>
        Object.hasOwn(input, column) && typeof input[column] === "string",
    );

/** How a row that failed {@link isCsvRow} departs from the pinned header. */
export const columnDrift = (columns: readonly string[], input: unknown) => {
  const row = isRecord(input) ? input : {};
  const declared = new Set(columns);
  return {
    missing: columns.filter((column) => !Object.hasOwn(row, column)),
    unexpected: Object.keys(row).filter((key) => !declared.has(key)),
    notText: columns.filter(
      (column) => Object.hasOwn(row, column) && typeof row[column] !== "string",
    ),
  };
};

// ── Typed readings of the scalar spellings ──────────────

/** The largest ID the publisher's 64-bit keys can hold. */
const MAX_ID = "9223372036854775807";

/**
 * A row ID: a positive decimal with no sign, space or leading zero, within
 * the publisher's key range. The length is checked first, so an oversized
 * value is refused without being read further.
 */
export const isCanonicalId = (value: string): boolean =>
  value.length <= MAX_ID.length &&
  /^[1-9][0-9]*$/u.test(value) &&
  compareCanonicalIds(value, MAX_ID) <= 0;

/** A boolean column holds `t` or `f`; anything else reads as `null`. */
export const readCsvBoolean = (value: string): boolean | null => {
  if (value === "t") {
    return true;
  }
  return value === "f" ? false : null;
};

/** A nullable numeric column holds blank or decimal text. */
export const isNullableDecimal = (value: string): boolean =>
  /^(?:-?[0-9]+)?$/u.test(value);

export const hasVisibleText = (value: string): boolean => /\S/u.test(value);
