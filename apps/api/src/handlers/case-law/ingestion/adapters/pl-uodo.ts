/**
 * Polish data-protection authority (Prezes UODO) adapter.
 *
 * orzeczenia.uodo.gov.pl publishes the authority's decisions through a
 * documented search API, and files beside them the court rulings on those
 * decisions and a set of legislation. One search answers every listing this
 * adapter reads:
 *
 *   /api/documents/search/PublicDocument/{from},{to}/{index}:{op}:{value}
 *       ?count&from&order&fields
 *
 * `fields=*,mtime` returns each document's whole index record — the same
 * record the per-document `meta.json` serves — plus its modification time, so
 * the listing row is the metadata and only the decision body needs a request
 * of its own.
 *
 * What is ingested, per the record's `publicator`:
 *
 *   gov/uodo     the authority's decisions, under the authority's name, with
 *                the body XML the record names as its `body` resource
 *   court/…/pl   the rulings of Polish courts the portal carries (the
 *                administrative courts reviewing the decisions, a few common
 *                and Supreme Court rulings), under the court that decided
 *                them; the portal holds no text for these, only the record,
 *                so they are stored unpublished and meet the courts' own
 *                rows through the key they carry
 *   everything else  skipped, counted by reason
 *
 * The crawl is a keyset frontier over `(mtime, id)`, so a new document and
 * a document the portal updates (an appeal outcome added to a decision's
 * dates) both land after the cursor. Cursor format: `<mtime ms>:<event id of
 * the last record read>`, and `:<day>` once a lap has reached the tip. A
 * parked crawl laps once per closed day: a cycle on the day it parked makes no
 * request and returns its cursor unchanged, and the first cycle after asks the
 * two searches past its last record.
 *
 * Reconciliation slices are decision years, which the search filters on.
 */

import { Result, panic } from "better-result";

import { polishAdministrativeDocketOf } from "@stll/api-contract/decision-docket-grammar";
import { readCappedBytes } from "@stll/skills/streaming";
import { parsePlainDate, Temporal } from "@stll/time";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  STORED_RAW_REPARSE_REJECTION,
  sourceTotalProbeFailed,
  sourceTotalRead,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  DecisionJudgeInput,
  EmptyAst,
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceFieldDisposition,
  SourceRawParts,
  SourceSurfaceCensus,
  SourceSurfaceDisposition,
  SourceTotalCount,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
import { plAdministrativeCourtRulingKeys } from "@/api/handlers/case-law/ingestion/adapters/pl-administrative-ruling-keys";
import { plCommonCourtRulingKeys } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import { plSupremeCourtRulingKeys } from "@/api/handlers/case-law/ingestion/adapters/pl-sn-ruling-keys";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parsePlUodoDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/pl-uodo";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import {
  absentDecisionTextFields,
  checkedDecisionMetadata,
  presentTextField,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { logger } from "@/api/lib/observability/logger";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { isRecord } from "@/api/lib/type-guards";

// ── Publisher boundary ───────────────────────────────────

const PL_UODO_ORIGIN = "https://orzeczenia.uodo.gov.pl";

/**
 * The only origin this adapter may reach. Every URL is built here from an
 * identifier checked against the portal's own format, and the check below is
 * what keeps it that way if a record ever states something else.
 */
const PL_UODO_HOST_POLICY = {
  type: "exact-origin",
  origins: [PL_UODO_ORIGIN],
} as const;

const SEARCH_PATH = "/api/documents/search/PublicDocument";

/** The whole index record, and the modification time it leaves out. */
const LISTING_FIELDS = "*,mtime";

/** Shortest gap between two requests, from the policy map that enforces it. */
const MIN_REQUEST_INTERVAL_MS = publisherRequestIntervalMs(
  ADAPTER_KEYS.PL_UODO,
);

/**
 * Records the crawl reads at a time. Each decision among them costs one body
 * request behind the one-second gate, so twenty is about twenty seconds.
 */
const CRAWL_PAGE_SIZE = 20;

/** Records a reconciliation listing asks for; it fetches no bodies. */
const LISTING_PAGE_SIZE = 100;

/**
 * What the total probe asks for in one request. The portal holds about 1,200
 * records; a probe that comes back full has hit this ceiling rather than the
 * end, and is reported as unreadable instead of as a total.
 */
const TOTAL_PROBE_COUNT = 10_000;

const PL_UODO_LANGUAGE = "pl";

const PL_UODO_COUNTRY = ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_UODO].country;

/** The decision type the authority issues, in its own language. */
const PL_UODO_DECISION_TYPE = "decyzja";

/** The first decision year the portal files anything under. */
const PL_UODO_FIRST_SLICE = ADAPTER_MANIFESTS[
  ADAPTER_KEYS.PL_UODO
].dateRange.fromInclusive.slice(0, 4);

/**
 * Year slices near the tip the reconciliation re-walks on a fast cadence.
 * Counted in slices, so this is the current year and the one before it: the
 * portal adds an administrative court's ruling months after its date.
 */
const PL_UODO_TIP_WINDOW_SLICES = 2;

/** `urn:ndoc:gov:pl:uodo:2023:dkn_5131_34`, the portal's document id. */
const DOCUMENT_URN =
  /^urn:ndoc:[a-z]+:[a-z]+:[a-z]+:\d{4}:[\p{Ll}\p{Nd}_.-]+$/u;

/** The portal's event id, which its body resources are addressed under. */
const EVENT_ID = /^PublicDocument-\d{8}-\d{6}-\d{3}-[0-9a-f]{32}$/u;

/**
 * Ceilings on what one response may hold. A listing page of a hundred records
 * runs to a few hundred kilobytes and the largest decision body to a few
 * hundred more; these leave an order of magnitude over both.
 */
const SEARCH_MAX_BYTES = 16 * 1024 * 1024;
const BODY_MAX_BYTES = 16 * 1024 * 1024;

/** A body resource name as the index states it: `000_pl.xml`. */
const BODY_RESOURCE_NAME = /^\d{3}_[a-z]{2}\.xml$/u;

// ── Publisher payloads ───────────────────────────────────

type Scalar = string | number | boolean | null;

type LocalizedText = Readonly<Record<string, string>>;

export type PlUodoExternalId = { id: string; type: string | undefined };

export type PlUodoPublicator = {
  type: string | undefined;
  subtype: string | undefined;
  name: string | undefined;
  country: string | undefined;
  year: string | undefined;
  extids: PlUodoExternalId[];
  volnumber: Scalar | undefined;
  docnumber: Scalar | undefined;
  pagefrom: Scalar | undefined;
  pageto: Scalar | undefined;
};

export type PlUodoPublication = {
  status: string | undefined;
  inforce: boolean | undefined;
  version: string | undefined;
  pubid: Scalar | undefined;
};

/**
 * One dated event the record states. `refid` on an event names the document
 * it concerns: a decision's `defended`, `repealed` and `trial` events name the
 * court ruling on its appeal, and `validation` may name the ruling that made
 * it final.
 */
export type PlUodoDate = {
  date: string | undefined;
  use: string | undefined;
  type: string | undefined;
  status: string | undefined;
  scope: string | undefined;
  text: string | undefined;
  refid: string | undefined;
  refname: string | undefined;
};

export type PlUodoEntity = {
  name: string | undefined;
  title: string | undefined;
  function: string | undefined;
  date: string | undefined;
};

export type PlUodoTerm = {
  label: string | undefined;
  name: LocalizedText | undefined;
  base: string | undefined;
  scope: string | undefined;
};

export type PlUodoRef = {
  refid: string | undefined;
  name: string | undefined;
  relation: string | undefined;
  type: string | undefined;
  source: string | undefined;
  dest: string | undefined;
};

export type PlUodoResource = {
  file: string;
  ref: string | undefined;
  lang: string | undefined;
  kind: string | undefined;
  mimetype: string | undefined;
  size: number | undefined;
  checksum: string | undefined;
};

/** One index record, read leniently: the shape of what is read is checked. */
export type PlUodoRow = {
  type: string | undefined;
  version: string | undefined;
  id: string | undefined;
  time: string | undefined;
  mtime: string | undefined;
  languages: string[];
  name: string | undefined;
  title: string | undefined;
  refid: string | undefined;
  refname: string | undefined;
  kind: string | undefined;
  parts: number | undefined;
  publication: PlUodoPublication;
  publicator: PlUodoPublicator;
  dates: PlUodoDate[];
  entities: PlUodoEntity[];
  terms: PlUodoTerm[];
  refs: PlUodoRef[];
  resources: PlUodoResource[];
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const nonEmpty = (value: unknown): string | undefined => {
  const read = text(value)?.trim();
  return read === undefined || read.length === 0 ? undefined : read;
};

const scalar = (value: unknown): Scalar | undefined =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  value === null
    ? value
    : undefined;

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** `{"pl": "…", "en": "…"}` with its non-empty strings, or undefined. */
const localized = (value: unknown): LocalizedText | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([language, printed]) => {
    const read = nonEmpty(printed);
    return read === undefined ? [] : [[language, read] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

/** The Polish text of a localized value, or the one text a plain value is. */
const polish = (value: unknown): string | undefined =>
  typeof value === "string" ? nonEmpty(value) : localized(value)?.["pl"];

export const normalizePlUodoRow = (
  value: Record<string, unknown>,
): PlUodoRow => {
  const publicator = isRecord(value["publicator"]) ? value["publicator"] : {};
  const publication = isRecord(value["publication"])
    ? value["publication"]
    : {};
  const resources = isRecord(value["resources"]) ? value["resources"] : {};
  const parts = value["parts"];
  return {
    type: nonEmpty(value["type"]),
    version: nonEmpty(value["version"]),
    id: nonEmpty(value["id"]),
    time: nonEmpty(value["time"]),
    mtime: nonEmpty(value["mtime"]),
    languages: Array.isArray(value["languages"])
      ? value["languages"].filter((item) => typeof item === "string")
      : [],
    name: polish(value["name"]),
    title: polish(value["title"]),
    refid: nonEmpty(value["refid"]),
    refname: nonEmpty(value["refname"]),
    kind: text(value["kind"]),
    parts: typeof parts === "number" ? parts : undefined,
    publication: {
      status: nonEmpty(publication["status"]),
      inforce:
        typeof publication["inforce"] === "boolean"
          ? publication["inforce"]
          : undefined,
      version: nonEmpty(publication["version"]),
      pubid: scalar(publication["pubid"]),
    },
    publicator: {
      type: nonEmpty(publicator["type"]),
      subtype: nonEmpty(publicator["subtype"]),
      name: polish(publicator["name"]),
      country: nonEmpty(publicator["country"]),
      year: nonEmpty(publicator["year"]),
      extids: records(publicator["extids"]).flatMap((extid) => {
        const id = nonEmpty(extid["id"]);
        return id === undefined ? [] : [{ id, type: nonEmpty(extid["type"]) }];
      }),
      volnumber: scalar(publicator["volnumber"]),
      docnumber: scalar(publicator["docnumber"]),
      pagefrom: scalar(publicator["pagefrom"]),
      pageto: scalar(publicator["pageto"]),
    },
    dates: records(value["dates"]).map((date) => ({
      date: nonEmpty(date["date"]),
      use: nonEmpty(date["use"]),
      type: nonEmpty(date["type"]),
      status: nonEmpty(date["status"]),
      scope: nonEmpty(date["scope"]),
      text: polish(date["text"]),
      refid: nonEmpty(date["refid"]),
      refname: nonEmpty(date["refname"]),
    })),
    entities: records(value["entities"]).map((entity) => ({
      name: polish(entity["name"]),
      title: polish(entity["title"]),
      function: nonEmpty(entity["function"]),
      date: nonEmpty(entity["date"]),
    })),
    terms: records(value["terms"]).map((term) => ({
      label: nonEmpty(term["label"]),
      name: localized(term["name"]),
      base: nonEmpty(term["base"]),
      scope: nonEmpty(term["scope"]),
    })),
    refs: records(value["refs"]).map((ref) => ({
      refid: nonEmpty(ref["refid"]),
      name: nonEmpty(ref["name"]),
      relation: nonEmpty(ref["relation"]),
      type: nonEmpty(ref["type"]),
      source: nonEmpty(ref["source"]),
      dest: nonEmpty(ref["dest"]),
    })),
    resources: Object.entries(resources).flatMap(([file, resource]) =>
      isRecord(resource)
        ? [
            {
              file,
              ref: nonEmpty(resource["ref"]),
              lang: nonEmpty(resource["lang"]),
              kind: nonEmpty(resource["kind"]),
              mimetype: nonEmpty(resource["mimetype"]),
              size:
                typeof resource["size"] === "number"
                  ? resource["size"]
                  : undefined,
              checksum: nonEmpty(resource["checksum"]),
            },
          ]
        : [],
    ),
  };
};

// ── What a record is ─────────────────────────────────────

/**
 * Why a record the portal lists is not ingested. Counted per page and per
 * slice, so what was left out is a number and not a silence.
 */
export const PL_UODO_SKIP_REASON = {
  /** Acts, regulations and journal notices (`publicator.type` `pro`). */
  LEGISLATION: "legislation",
  /**
   * A court's judgment as a journal reprints it: the CJEU's in the EU journal,
   * the Constitutional Tribunal's in the Polish one. The courts publish them
   * themselves, and the corpus takes them from there.
   */
  RULING_IN_JOURNAL: "ruling-in-journal",
  /** Guidance of another body, such as the EDPB's guidelines. */
  OTHER_AUTHORITY: "other-authority",
  /** A court record whose court this adapter does not recognise. */
  UNRECOGNISED_COURT: "unrecognised-court",
  /** An authority record whose signing office this adapter does not recognise. */
  UNRECOGNISED_AUTHORITY: "unrecognised-authority",
  /** A publisher kind nobody declared here. */
  UNRECOGNISED_PUBLISHER: "unrecognised-publisher",
} as const;

export type PlUodoSkipReason =
  (typeof PL_UODO_SKIP_REASON)[keyof typeof PL_UODO_SKIP_REASON];

export type PlUodoCourtLevel =
  | "supreme-administrative"
  | "regional-administrative"
  | "supreme"
  | "common";

export type PlUodoCourt = {
  /** The court's full official name, which is what the row is filed under. */
  name: string;
  level: PlUodoCourtLevel;
  /** The court as the record names it, when that differs from `name`. */
  asPrinted: string;
  /** Set for the administrative court as it sat before the 2004 reform. */
  era?: "pre-2004" | undefined;
  /** The pre-reform court's branch seat, as the record names it. */
  branch?: string | undefined;
};

/** The office a decision names as its author, read off the record. */
export type PlUodoAuthority = {
  name: string;
  /** The signing line as the record prints it. */
  asPrinted: string;
  /** Signed by someone the President authorised (`z up.`). */
  onAuthority: boolean;
};

export type PlUodoRecordClass =
  | { type: "authority-decision"; authority: PlUodoAuthority }
  | { type: "court-ruling"; court: PlUodoCourt }
  | { type: "skipped"; reason: PlUodoSkipReason };

const NSA = "Naczelny Sąd Administracyjny";
const WSA_PREFIX = "Wojewódzki Sąd Administracyjny ";

/** Seats the record abbreviates, spelled as the court's name spells them. */
const WSA_SEAT_SPELLINGS: Readonly<Record<string, string>> = {
  "w Gorzowie Wlkp.": "w Gorzowie Wielkopolskim",
};

const PRE_REFORM_NSA = "NSA w Warszawie (przed reformą)";
const PRE_REFORM_BRANCH = /^NSA oz\. (?<seat>we? \p{Lu}.*)$/u;
const COMMON_COURT = /^Sąd (?:Rejonowy|Okręgowy|Apelacyjny)\b/u;
const SUPREME_COURT_NAME = /\bSądu Najwyższego\b/u;

/** The court part of a record name: `Wyrok - Naczelny Sąd Administracyjny`. */
const courtPartOf = (name: string | undefined): string | undefined =>
  nonEmpty(name?.split(/(?:^|\s)-\s/u).at(-1));

const administrativeCourtOf = (
  printed: string | undefined,
): PlUodoCourt | null => {
  if (printed === undefined) {
    return null;
  }
  if (printed === NSA) {
    return { name: NSA, level: "supreme-administrative", asPrinted: printed };
  }
  if (printed === PRE_REFORM_NSA) {
    return {
      name: NSA,
      level: "supreme-administrative",
      asPrinted: printed,
      era: "pre-2004",
    };
  }
  const seat = PRE_REFORM_BRANCH.exec(printed)?.groups?.["seat"];
  if (seat !== undefined) {
    return {
      name: NSA,
      level: "supreme-administrative",
      asPrinted: printed,
      era: "pre-2004",
      branch: `Ośrodek Zamiejscowy ${seat}`,
    };
  }
  if (printed.startsWith(WSA_PREFIX)) {
    const printedSeat = printed.slice(WSA_PREFIX.length);
    return {
      name: `${WSA_PREFIX}${WSA_SEAT_SPELLINGS[printedSeat] ?? printedSeat}`,
      level: "regional-administrative",
      asPrinted: printed,
    };
  }
  return null;
};

const PRESIDENT = "Prezes Urzędu Ochrony Danych Osobowych";

/**
 * The signing lines the portal prints on a decision's `creator`, and whether
 * each is the President signing or someone signing on the President's
 * authority. The office decides either way.
 */
const AUTHORITY_SIGNING_LINES: Readonly<Record<string, boolean>> = {
  [PRESIDENT]: false,
  "z up. Prezesa Urzędu Ochrony Danych Osobowych": true,
};

/**
 * The deciding office of an authority record, from the signing line its
 * `creator` entity states, or null where the record states none this table
 * knows: a record never inherits the portal's own name as its author.
 */
const authorityOf = (row: PlUodoRow): PlUodoAuthority | null => {
  const printed = row.entities.find(
    (entity) => entity.function === "creator",
  )?.title;
  const onAuthority =
    printed === undefined ? undefined : AUTHORITY_SIGNING_LINES[printed];
  return printed === undefined || onAuthority === undefined
    ? null
    : { name: PRESIDENT, asPrinted: printed, onAuthority };
};

/**
 * The deciding court of a court record. `sa` is the administrative courts'
 * database, `sp` the common courts' portal and `sn` the Supreme Court's; the
 * record's name states the court within each.
 */
const rulingCourtOf = (row: PlUodoRow): PlUodoCourt | null => {
  const { subtype } = row.publicator;
  if (subtype === "sa") {
    return administrativeCourtOf(courtPartOf(row.name));
  }
  if (subtype === "sp") {
    const printed = courtPartOf(row.name);
    return printed !== undefined && COMMON_COURT.test(printed)
      ? { name: printed, level: "common", asPrinted: printed }
      : null;
  }
  if (subtype === "sn") {
    return row.name !== undefined && SUPREME_COURT_NAME.test(row.name)
      ? { name: "Sąd Najwyższy", level: "supreme", asPrinted: row.name }
      : null;
  }
  return null;
};

/**
 * What a record is, read off who published it.
 *
 * The publisher kind is the portal's own classification, so nothing here
 * reads a title: `gov/uodo` is the authority, `court` with country `pl` is a
 * Polish court, and a `pro` record is a journal publication — legislation, or
 * a court's judgment where its document id says it is one.
 */
export const classifyPlUodoRow = (row: PlUodoRow): PlUodoRecordClass => {
  const { country, subtype, type } = row.publicator;
  if (type === "gov") {
    if (subtype !== "uodo") {
      return { type: "skipped", reason: PL_UODO_SKIP_REASON.OTHER_AUTHORITY };
    }
    const authority = authorityOf(row);
    if (authority === null) {
      logger.warn("case_law.ingestion.court_not_stated", {
        adapterKey: ADAPTER_KEYS.PL_UODO,
        court: row.name ?? "",
      });
      return {
        type: "skipped",
        reason: PL_UODO_SKIP_REASON.UNRECOGNISED_AUTHORITY,
      };
    }
    return { type: "authority-decision", authority };
  }
  if (type === "court" && country === "pl") {
    const court = rulingCourtOf(row);
    if (court === null) {
      logger.warn("case_law.ingestion.court_not_stated", {
        adapterKey: ADAPTER_KEYS.PL_UODO,
        court: row.name ?? "",
      });
      return {
        type: "skipped",
        reason: PL_UODO_SKIP_REASON.UNRECOGNISED_COURT,
      };
    }
    return { type: "court-ruling", court };
  }
  if (type === "pro") {
    return row.refid?.startsWith("urn:ndoc:court:") === true
      ? { type: "skipped", reason: PL_UODO_SKIP_REASON.RULING_IN_JOURNAL }
      : { type: "skipped", reason: PL_UODO_SKIP_REASON.LEGISLATION };
  }
  return {
    type: "skipped",
    reason: PL_UODO_SKIP_REASON.UNRECOGNISED_PUBLISHER,
  };
};

export type PlUodoSkipTally = Partial<Record<PlUodoSkipReason, number>>;

/** How many of these records are skipped, per reason. */
export const tallyPlUodoSkips = (
  rows: readonly PlUodoRow[],
): PlUodoSkipTally => {
  const tally: PlUodoSkipTally = {};
  for (const row of rows) {
    const recordClass = classifyPlUodoRow(row);
    if (recordClass.type === "skipped") {
      tally[recordClass.reason] = (tally[recordClass.reason] ?? 0) + 1;
    }
  }
  return tally;
};

const reportSkips = (where: string, tally: PlUodoSkipTally): void => {
  if (Object.keys(tally).length === 0) {
    return;
  }
  logger.info("case_law.ingestion.records_out_of_scope", {
    adapterKey: ADAPTER_KEYS.PL_UODO,
    where,
    ...tally,
  });
};

// ── Identity, dockets and links ──────────────────────────

const isDocumentUrn = (value: string | undefined): value is string =>
  value !== undefined &&
  DOCUMENT_URN.test(value) &&
  isPersistableSourceDocumentId(value);

const QUARANTINE_PREFIX = "pl-uodo-quarantine:";

/**
 * The audit identity of a record that states no usable URN: a digest of the
 * fields that stay the same once the portal fixes the URN, so the recovered
 * record can adopt the quarantined row instead of duplicating it. Undefined
 * for a record stating none of them, which nothing could tell apart.
 */
export const plUodoQuarantineId = (row: PlUodoRow): string | undefined => {
  if (
    row.refname === undefined &&
    row.name === undefined &&
    row.title === undefined
  ) {
    return undefined;
  }
  return `${QUARANTINE_PREFIX}${hashContent(
    JSON.stringify({
      refname: row.refname ?? null,
      time: row.time ?? null,
      kind: row.kind ?? null,
      name: row.name ?? null,
      title: row.title ?? null,
      type: row.publicator.type ?? null,
      subtype: row.publicator.subtype ?? null,
      country: row.publicator.country ?? null,
    }),
  )}`;
};

const isQuarantineId = (sourceDocumentId: string): boolean =>
  sourceDocumentId.startsWith(QUARANTINE_PREFIX);

/**
 * The identity a record is stored under: the portal's document URN, which is
 * what it addresses every content request by and what other records' links
 * name; the quarantine digest where the record states no usable URN, so the
 * row is kept verbatim instead of dropped. Stated once so the crawl and the
 * reconciliation cannot differ.
 */
export const plUodoListingIdentity = (row: PlUodoRow): ListingIdentity => {
  if (isDocumentUrn(row.refid)) {
    return { type: "document", sourceDocumentId: row.refid };
  }
  const quarantineId = plUodoQuarantineId(row);
  return quarantineId === undefined
    ? { type: "unidentifiable" }
    : { type: "document", sourceDocumentId: quarantineId };
};

/**
 * Whether an identity is complete as its record: a court ruling, which the
 * portal files with no text, and a quarantined record, which can hold nothing
 * more until the portal states its URN. The URN names the publisher kind, and
 * the listing carries no other court records, so the identity alone answers.
 */
export const plUodoHeldWithoutDetail = (identity: ListingIdentity): boolean =>
  identity.type === "document" &&
  (identity.sourceDocumentId.startsWith("urn:ndoc:court:pl:") ||
    isQuarantineId(identity.sourceDocumentId));

const collapse = (value: string): string => value.replace(/\s+/gu, " ").trim();

/**
 * The docket of an administrative-court record, in the shared grammar's
 * spelling where it reads one, which is how the courts' own database keys
 * the same ruling.
 */
const administrativeDocketOf = (
  refname: string,
): { caseNumber: string; recognised: boolean } => {
  const collapsed = collapse(refname);
  const recognised = polishAdministrativeDocketOf(collapsed);
  return recognised === null
    ? { caseNumber: collapsed, recognised: false }
    : { caseNumber: recognised, recognised: true };
};

/** `urn:ndoc:court:pl:sa:2025:ii_sa-wa_124` → its three docket parts. */
const ADMINISTRATIVE_COURT_URN =
  /^urn:ndoc:court:pl:sa:(?<year>\d{4}):(?<division>[ivx]+)_(?<register>[a-z]+(?:-[a-zł]+)?)_(?<number>\d+)$/u;

/**
 * The docket an administrative-court document URN encodes, for a link that
 * names the ruling by URN alone: `II SA/Wa 124/25`. Returned only when the
 * shared grammar reads the result as a docket.
 */
export const plUodoDocketOfCourtUrn = (urn: string): string | null => {
  const groups = ADMINISTRATIVE_COURT_URN.exec(urn)?.groups;
  if (groups === undefined) {
    return null;
  }
  const [mark = "", seat] = (groups["register"] ?? "").split("-");
  const register =
    seat === undefined
      ? mark.toUpperCase()
      : `${mark.toUpperCase()}/${seat.charAt(0).toUpperCase()}${seat.slice(1)}`;
  const docket = `${(groups["division"] ?? "").toUpperCase()} ${register} ${groups["number"] ?? ""}/${(groups["year"] ?? "").slice(2)}`;
  return polishAdministrativeDocketOf(docket);
};

/** One link from a record to a ruling on it, as the record's dates state it. */
export type PlUodoLinkedRuling = {
  /** The event: `defended`, `repealed`, `trial` or `validation`. */
  relation: string;
  date: string | undefined;
  status: string | undefined;
  scope: string | undefined;
  text: string | undefined;
  /** The portal's URN of the ruling, which is its identity in this source. */
  sourceDocumentId: string;
  /** The ruling's docket, where the record or the URN states one. */
  caseNumber: string | undefined;
};

/**
 * Every ruling the record's dates link it to, with the docket read from the
 * record's own references where it names one, then from the URN.
 */
export const plUodoLinkedRulings = (row: PlUodoRow): PlUodoLinkedRuling[] => {
  const refNames = new Map(
    row.refs.flatMap((ref) =>
      ref.refid === undefined || ref.name === undefined
        ? []
        : [[ref.refid, ref.name] as const],
    ),
  );
  return row.dates.flatMap((date) => {
    const { refid } = date;
    if (refid === undefined || date.use === undefined) {
      return [];
    }
    const named = date.refname ?? refNames.get(refid);
    const caseNumber =
      named === undefined
        ? (plUodoDocketOfCourtUrn(refid) ?? undefined)
        : administrativeDocketOf(named).caseNumber;
    return [
      {
        relation: date.use,
        date: date.date,
        status: date.status,
        scope: date.scope,
        text: date.text,
        sourceDocumentId: refid,
        caseNumber,
      },
    ];
  });
};

/** The Polish function words the courts' bench lists print, and their roles. */
const BENCH_ROLES: Readonly<
  Record<string, readonly DecisionJudgeInput["role"][]>
> = {
  przewodniczący: [DECISION_JUDGE_ROLE.PRESIDING],
  sprawozdawca: [DECISION_JUDGE_ROLE.RAPPORTEUR],
  współsprawozdawca: [DECISION_JUDGE_ROLE.RAPPORTEUR],
  "przewodniczący sprawozdawca": [
    DECISION_JUDGE_ROLE.PRESIDING,
    DECISION_JUDGE_ROLE.RAPPORTEUR,
  ],
};

/**
 * The bench a court record names: each judge as a panel member, and again
 * under the function the record gives them. A function this table does not
 * know (the common courts' `SO`) leaves the judge a panel member only.
 */
export const plUodoBenchOf = (row: PlUodoRow): DecisionJudgeInput[] =>
  row.entities.flatMap((entity) => {
    const { name } = entity;
    if (name === undefined) {
      return [];
    }
    // A function the table does not name adds no role beyond panel member.
    const roles = BENCH_ROLES[entity.function ?? ""];
    return [
      ...(roles === undefined
        ? []
        : roles.map((role) => ({ role, nameAsPrinted: name }))),
      { role: DECISION_JUDGE_ROLE.PANEL_MEMBER, nameAsPrinted: name },
    ];
  });

/** The kinds a court record states, in the court's own language. */
const RULING_KINDS = ["wyrok", "postanowienie", "uchwała"] as const;

const rulingKindOf = (kind: string | undefined): string | undefined => {
  const lowered = kind?.trim().toLocaleLowerCase("pl-PL") ?? "";
  const matched = RULING_KINDS.find((candidate) => candidate === lowered);
  if (matched === undefined) {
    logger.warn("case_law.ingestion.decision_type_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_UODO,
      decisionForm: kind ?? "",
    });
  }
  return matched;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/u;

const dayOf = (instant: string | undefined): string | undefined =>
  instant !== undefined && ISO_DAY.test(instant)
    ? instant.slice(0, 10)
    : undefined;

// ── Addresses ────────────────────────────────────────────

/**
 * Every URL is built from the fixed origin and an identifier checked against
 * the portal's format, so a rejection means the construction here changed,
 * not the publisher.
 */
const ESCAPED_ORIGIN =
  "orzeczenia.uodo.gov.pl request escaped the publisher origin";

const documentPageUrl = (urn: string): string =>
  `${PL_UODO_ORIGIN}/document/${urn}/content`;

const bodyPdfUrl = (urn: string, ref: string): string =>
  `${PL_UODO_ORIGIN}/api/documents/public/items/${urn}:${ref}/body.pdf`;

type SearchQuery = {
  /** `YYYY-MM-DD,YYYY-MM-DD`, either end open. */
  timespan: string;
  /** `index:op:value`, or none. */
  condition?: string | undefined;
  count: number;
  from: number;
  order?: string | undefined;
  fields: string;
};

export const plUodoSearchUrl = ({
  condition,
  count,
  fields,
  from,
  order,
  timespan,
}: SearchQuery): string => {
  const params = new URLSearchParams({
    count: String(count),
    from: String(from),
    ...(order === undefined ? {} : { order }),
    fields,
  });
  const path =
    condition === undefined
      ? `${SEARCH_PATH}/${timespan}`
      : `${SEARCH_PATH}/${timespan}/${condition}`;
  return `${PL_UODO_ORIGIN}${path}?${params.toString()}`;
};

// ── Requests ─────────────────────────────────────────────

const publisherError = (
  cursor: string,
  message: string,
  httpStatus?: number,
): AdapterFetchError =>
  new AdapterFetchError({
    message: `orzeczenia.uodo.gov.pl: ${message}`,
    adapterKey: ADAPTER_KEYS.PL_UODO,
    cursor,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

type SearchOptions = {
  cursor: string;
  query: SearchQuery;
  signal?: AbortSignal | undefined;
};

type SearchAnswer = {
  rows: Record<string, unknown>[];
  /**
   * How many entries the portal returned, before the shape filter. This, not
   * the filtered count, says whether a page was full.
   */
  served: number;
  url: string;
};

/**
 * One search request. An answer that is not a JSON array is a failure, never
 * an empty result: the portal reports its own errors as text at 500.
 */
const search = async ({
  cursor,
  query,
  signal,
}: SearchOptions): Promise<Result<SearchAnswer, AdapterFetchError>> => {
  const target = restrictOutboundUrl({
    hostPolicy: PL_UODO_HOST_POLICY,
    rawUrl: plUodoSearchUrl(query),
  });
  if (target === null) {
    return panic(ESCAPED_ORIGIN);
  }
  const url = target.toString();
  const response = await fetchWithRetry(
    url,
    { headers: { Accept: "application/json" }, redirect: "error" },
    {
      adapterKey: ADAPTER_KEYS.PL_UODO,
      signal,
      timeoutMs: ADAPTER_TIMEOUT.LIST,
    },
  );
  if (!response.ok) {
    return Result.err(
      publisherError(
        cursor,
        `search answered ${response.status}`,
        response.status,
      ),
    );
  }
  const bytes =
    response.body === null
      ? new Uint8Array()
      : await readCappedBytes(response.body, SEARCH_MAX_BYTES);
  if (bytes === null) {
    return Result.err(
      publisherError(cursor, `search answered over ${SEARCH_MAX_BYTES} bytes`),
    );
  }
  const parsed = Result.try({
    try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
    catch: () => null,
  }).unwrapOr(null);
  if (!Array.isArray(parsed)) {
    return Result.err(publisherError(cursor, "search answered no JSON array"));
  }
  const entries: unknown[] = parsed;
  const rows = entries.filter(isRecord);
  if (rows.length !== entries.length) {
    // `fields` asks for records; bare ids or anything else in their place is
    // an answer this adapter cannot read, and reading past it would advance
    // the cursor over rows it never saw.
    return Result.err(
      publisherError(
        cursor,
        `search answered ${entries.length - rows.length} entries that are not records`,
      ),
    );
  }
  return Result.ok({ rows, served: entries.length, url });
};

/**
 * Why a decision is stored without its body. Each is a statement about the
 * publisher that holds on the next cycle too, so the row is kept on its record
 * and the listing-only repair asks again; a transient refusal fails the page
 * instead.
 */
export const PL_UODO_BODY_STATUS = {
  /** The record names no body resource, or no event to fetch it under. */
  NOT_LISTED: "body-not-listed",
  NOT_FOUND: "body-http-404",
  GONE: "body-http-410",
  /**
   * The body address redirected. Requests here refuse redirects, so which
   * kind it was cannot be read; the portal addresses a body by the record's
   * event, which it replaces when it re-issues the record, and the crawl
   * reads the re-issued record under its new event anyway. Kept as a record
   * the repair asks again, rather than a page that fails every cycle.
   */
  REDIRECTED: "body-redirected",
  TOO_LARGE: "body-too-large",
  /** The record states no URN; see `plUodoQuarantineId`. */
  IDENTITY_UNAVAILABLE: "identity-unavailable",
} as const;

export type PlUodoBodyStatus =
  (typeof PL_UODO_BODY_STATUS)[keyof typeof PL_UODO_BODY_STATUS];

const PL_UODO_BODY_STATUSES: ReadonlySet<string> = new Set(
  Object.values(PL_UODO_BODY_STATUS),
);

const isBodyStatus = (value: unknown): value is PlUodoBodyStatus =>
  typeof value === "string" && PL_UODO_BODY_STATUSES.has(value);

/** Answers that say the body is not there, as opposed to not there now. */
const PERMANENT_BODY_ANSWERS: Readonly<Record<number, PlUodoBodyStatus>> = {
  404: PL_UODO_BODY_STATUS.NOT_FOUND,
  410: PL_UODO_BODY_STATUS.GONE,
};

/** The body resource a decision's record names, when it names one. */
export const plUodoBodyResourceOf = (
  row: PlUodoRow,
): PlUodoResource | undefined => {
  const bodies = row.resources.filter(
    (resource) =>
      resource.kind === "body" && BODY_RESOURCE_NAME.test(resource.file),
  );
  return (
    bodies.find((resource) => resource.lang === PL_UODO_LANGUAGE) ??
    bodies.at(0)
  );
};

const bodyUrlOf = (eventId: string, resource: PlUodoResource): string =>
  `${PL_UODO_ORIGIN}/api/documents/events/${eventId}/${resource.file}`;

const SHA256_CHECKSUM = /^\{SHA256\}(?<hex>[0-9a-f]{64})$/u;

/** Whether the served bytes are the ones the record's checksum names. */
const checksumMatches = (
  resource: PlUodoResource,
  bytes: Uint8Array,
): boolean | undefined => {
  const stated = SHA256_CHECKSUM.exec(resource.checksum ?? "")?.groups?.["hex"];
  if (stated === undefined) {
    return undefined;
  }
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex") === stated;
};

export type PlUodoBody = {
  xml: string;
  resource: PlUodoResource;
  /** False where the served bytes differ from the checksum the record states. */
  checksumMatches: boolean | undefined;
};

/**
 * The body a record's bytes are, checked against the checksum the record
 * states for its body resource. `undefined` where the record names none.
 */
export const plUodoBodyFrom = (
  row: PlUodoRow,
  bytes: Uint8Array,
): PlUodoBody | undefined => {
  const resource = plUodoBodyResourceOf(row);
  return resource === undefined
    ? undefined
    : {
        xml: new TextDecoder().decode(bytes),
        resource,
        checksumMatches: checksumMatches(resource, bytes),
      };
};

type FetchBodyOptions = {
  cursor: string;
  row: PlUodoRow;
  signal?: AbortSignal | undefined;
};

type FetchedBody =
  | { type: "served"; body: PlUodoBody }
  | { type: "absent"; status: PlUodoBodyStatus };

/** How the fetch layer reports a redirect it was told to refuse. */
const isRefusedRedirect = (error: unknown): boolean =>
  error instanceof TypeError &&
  "code" in error &&
  error.code === "UnexpectedRedirect";

/**
 * The decision's body; the reason it is absent where the portal answers for
 * good that it has none (not listed, 404, 410, a redirect, past the ceiling);
 * an error for a refusal that may clear (5xx, 429, any other status, a
 * dropped connection), so the page is asked again.
 */
const fetchBody = async ({
  cursor,
  row,
  signal,
}: FetchBodyOptions): Promise<Result<FetchedBody, AdapterFetchError>> => {
  const resource = plUodoBodyResourceOf(row);
  const eventId = row.id;
  if (
    resource === undefined ||
    eventId === undefined ||
    !EVENT_ID.test(eventId)
  ) {
    return Result.ok({
      type: "absent",
      status: PL_UODO_BODY_STATUS.NOT_LISTED,
    });
  }
  const target = restrictOutboundUrl({
    hostPolicy: PL_UODO_HOST_POLICY,
    rawUrl: bodyUrlOf(eventId, resource),
  });
  if (target === null) {
    return panic(ESCAPED_ORIGIN);
  }
  const requested = await Result.tryPromise({
    try: async () =>
      await fetchWithRetry(
        target.toString(),
        { headers: { Accept: "application/xml" }, redirect: "error" },
        {
          adapterKey: ADAPTER_KEYS.PL_UODO,
          signal,
          timeoutMs: ADAPTER_TIMEOUT.PAGE,
        },
      ),
    catch: (error: unknown) => error,
  });
  if (Result.isError(requested)) {
    return isRefusedRedirect(requested.error)
      ? Result.ok({ type: "absent", status: PL_UODO_BODY_STATUS.REDIRECTED })
      : Result.err(adapterCatch(ADAPTER_KEYS.PL_UODO, cursor)(requested.error));
  }
  const response = requested.value;
  const permanent = PERMANENT_BODY_ANSWERS[response.status];
  if (permanent !== undefined) {
    return Result.ok({ type: "absent", status: permanent });
  }
  if (!response.ok) {
    return Result.err(
      publisherError(
        cursor,
        `body answered ${response.status}`,
        response.status,
      ),
    );
  }
  const bytes =
    response.body === null
      ? new Uint8Array()
      : await readCappedBytes(response.body, BODY_MAX_BYTES);
  if (bytes === null) {
    // A body past the ceiling is as unreadable on the next cycle as on this
    // one, so the decision is kept as its record rather than holding the page.
    logger.warn("case_law.ingestion.document_too_large", {
      adapterKey: ADAPTER_KEYS.PL_UODO,
      caseNumber: row.refname ?? "",
      maxBytes: BODY_MAX_BYTES,
    });
    return Result.ok({ type: "absent", status: PL_UODO_BODY_STATUS.TOO_LARGE });
  }
  const body = plUodoBodyFrom(row, bytes);
  return Result.ok(
    body === undefined
      ? { type: "absent", status: PL_UODO_BODY_STATUS.NOT_LISTED }
      : { type: "served", body },
  );
};

// ── Building a decision ──────────────────────────────────

/**
 * The parts of the stored envelope, named by the response each holds. A
 * replay reads exactly what a crawl kept, so the names are the contract.
 */
const RAW_PART = {
  LISTING: "listing",
  BODY: "body-xml",
} as const;

export type PlUodoBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** No document URN to key on; nothing can store this record. */
  | { type: "unkeyable" }
  /** Not a record this adapter ingests. */
  | { type: "skipped"; reason: PlUodoSkipReason }
  /** A decision whose body the portal did not serve. */
  | { type: "detail-unavailable"; decision: IngestionResult };

export type AssemblePlUodoDecisionOptions = {
  row: PlUodoRow;
  body: PlUodoBody | undefined;
  /** Why `body` is absent, where the fetch said; `body-not-listed` otherwise. */
  bodyStatus?: PlUodoBodyStatus | undefined;
  rawParts: SourceRawParts;
};

/** The URN as a docket where the record prints none, marked as a stand-in. */
const caseNumberOf = (
  refname: string | undefined,
  urn: string,
): { caseNumber: string; caseNumberIsPlaceholder?: true } =>
  refname === undefined
    ? { caseNumber: urn, caseNumberIsPlaceholder: true }
    : { caseNumber: collapse(refname) };

/** The quarantine digest a keyed record would have had, for a later repair. */
const repairAliasesOf = (
  row: PlUodoRow,
): { sourceDocumentIdRepairAliases?: string[] } => {
  const quarantineId = plUodoQuarantineId(row);
  return quarantineId === undefined
    ? {}
    : { sourceDocumentIdRepairAliases: [quarantineId] };
};

/** What every record states, whichever kind it is. */
const recordMetadata = (row: PlUodoRow): Record<string, unknown> => ({
  documentId: row.refid,
  portalEventId: row.id,
  portalModifiedAt: row.mtime,
  documentKind: row.kind,
  documentName: row.name,
  languages: row.languages,
  parts: row.parts,
  publication: row.publication,
  publicator: {
    type: row.publicator.type,
    subtype: row.publicator.subtype,
    name: row.publicator.name,
    country: row.publicator.country,
    year: row.publicator.year,
    volnumber: row.publicator.volnumber,
    docnumber: row.publicator.docnumber,
    pagefrom: row.publicator.pagefrom,
    pageto: row.publicator.pageto,
  },
  externalIds: row.publicator.extids,
  publisherDates: row.dates,
  linkedRulings: plUodoLinkedRulings(row),
  entities: row.entities,
  subjectTerms: row.terms,
  keywords: row.terms.flatMap((term) => {
    const name = term.name?.["pl"];
    return name === undefined ? [] : [name];
  }),
  references: row.refs,
  resources: row.resources,
});

/** The dockets of the rulings and decisions the record cites. */
const citedDocketsOf = (row: PlUodoRow): string[] =>
  row.refs.flatMap((ref) =>
    ref.name !== undefined &&
    (ref.refid?.startsWith("urn:ndoc:court:pl:") === true ||
      ref.refid?.startsWith("urn:ndoc:gov:pl:uodo:") === true)
      ? [ref.name]
      : [],
  );

const summaryOf = (row: PlUodoRow) => ({
  ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  // The record's title: the subject of a decision, the operative header of an
  // administrative-court ruling, the thesis of a Supreme Court one. Always
  // the portal's own line about the document, never its text.
  ...(row.title === undefined ? {} : { summary: presentTextField(row.title) }),
});

const assembleAuthorityDecision = ({
  authority,
  body,
  bodyStatus = PL_UODO_BODY_STATUS.NOT_LISTED,
  rawParts,
  row,
  urn,
}: AssemblePlUodoDecisionOptions & {
  authority: PlUodoAuthority;
  urn: string;
}): PlUodoBuildResult => {
  const docket = caseNumberOf(row.refname, urn);
  const { caseNumber } = docket;
  const decisionDate = dayOf(row.time);
  const sourceUrl = documentPageUrl(urn);
  const resource = body?.resource ?? plUodoBodyResourceOf(row);
  const documentUrl =
    resource?.ref === undefined ? undefined : bodyPdfUrl(urn, resource.ref);

  // A parse failure is not the decision's failure: the body is stored
  // verbatim below, so its text is recoverable by re-parsing what was kept.
  const parsed =
    body === undefined
      ? null
      : parsePlUodoDecisionXml({
          xml: body.xml,
          documentId: urn,
          caseNumber,
          court: authority.name,
          decisionDate,
          decisionType: PL_UODO_DECISION_TYPE,
          sourceUrl,
        });
  if (parsed !== null && Result.isError(parsed)) {
    logger.warn("case_law.ingestion.document_parse_failed", {
      adapterKey: ADAPTER_KEYS.PL_UODO,
      caseNumber,
      "error.type": errorTag(parsed.error),
    });
  }
  const document = parsed !== null && Result.isOk(parsed) ? parsed.value : null;
  if (body?.checksumMatches === false) {
    logger.warn("case_law.ingestion.document_checksum_mismatch", {
      adapterKey: ADAPTER_KEYS.PL_UODO,
      caseNumber,
    });
  }
  const documentAst: DocumentAst | EmptyAst =
    document?.documentAst ?? EMPTY_AST;
  const creator = row.entities.find((entity) => entity.function === "creator");
  const department = row.entities.find(
    (entity) => entity.function === "department",
  );

  const sourceRaw = encodeSourceRawEnvelope(rawParts);
  const decision: IngestionResult = {
    ...docket,
    sourceDocumentId: urn,
    ...repairAliasesOf(row),
    court: authority.name,
    country: PL_UODO_COUNTRY,
    language: PL_UODO_LANGUAGE,
    decisionDate,
    decisionType: PL_UODO_DECISION_TYPE,
    fulltext: document?.fulltext,
    // The listing proves the decision exists; without its body this row
    // carries the record only and must never overwrite a body a later fetch
    // recovered.
    ...(body === undefined ? { isListingOnly: true } : {}),
    sourceUrl,
    documentUrl,
    textFields: summaryOf(row),
    publisherCitedCases: citedDocketsOf(row),
    metadata: checkedDecisionMetadata({
      caseNumber,
      court: authority.name,
      decisionDate,
      decisionType: PL_UODO_DECISION_TYPE,
      recordClass: "authority-decision",
      ...recordMetadata(row),
      issuedBy: creator?.name,
      issuedByTitle: authority.asPrinted,
      signedOnAuthority: authority.onAuthority,
      department: department?.name,
      ...(body?.checksumMatches === false
        ? { bodyChecksumMismatch: true }
        : {}),
      ...(body === undefined ? { detailStatus: bodyStatus } : {}),
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_UODO],
    documentAst,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
  return body === undefined
    ? { type: "detail-unavailable", decision }
    : { type: "built", decision };
};

/**
 * The keys the courts' own sources store the same ruling under: the
 * administrative courts' portal id and court, docket, date and kind for an
 * administrative court's ruling, and the Supreme Court's and the common
 * courts' keys for theirs.
 */
const rulingKeysOf = ({
  court,
  ...keyed
}: {
  court: PlUodoCourt;
  caseNumber: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  cbosaDocumentId: string | undefined;
}): string[] => {
  const input = {
    caseNumber: keyed.caseNumber,
    court: court.name,
    decisionDate: keyed.decisionDate,
    decisionType: keyed.decisionType,
  };
  return [
    ...plAdministrativeCourtRulingKeys({
      ...input,
      portalDocumentId: keyed.cbosaDocumentId,
    }),
    ...plSupremeCourtRulingKeys(input),
    ...(court.level === "common" ? plCommonCourtRulingKeys(input) : []),
  ];
};

/**
 * A ruling's docket: an administrative court's in the shared grammar's
 * spelling, any other court's as the record prints it.
 */
const rulingDocketOf = (
  row: PlUodoRow,
  urn: string,
): { caseNumber: string; recognised: boolean; placeholder?: true } => {
  if (row.refname === undefined) {
    return { caseNumber: urn, recognised: false, placeholder: true };
  }
  if (row.publicator.subtype !== "sa") {
    return { caseNumber: collapse(row.refname), recognised: false };
  }
  const printed = administrativeDocketOf(row.refname);
  if (printed.recognised) {
    return printed;
  }
  // The record's own spelling is sometimes mistyped (`II SA-Wa 609-20`); the
  // URN the portal keys the same record by then states the docket.
  const fromUrn = plUodoDocketOfCourtUrn(urn);
  return fromUrn === null ? printed : { caseNumber: fromUrn, recognised: true };
};

const assembleCourtRuling = ({
  court,
  rawParts,
  row,
  urn,
}: {
  court: PlUodoCourt;
  rawParts: SourceRawParts;
  row: PlUodoRow;
  urn: string;
}): PlUodoBuildResult => {
  const docket = rulingDocketOf(row, urn);
  const { caseNumber } = docket;
  const decisionDate = dayOf(row.time);
  const decisionType = rulingKindOf(row.kind);
  const cbosaDocumentId = row.publicator.extids.find(
    (extid) => extid.type === "cbosa",
  )?.id;
  const rulingKeys = rulingKeysOf({
    court,
    caseNumber,
    decisionDate,
    decisionType,
    cbosaDocumentId,
  });
  const sourceRaw = encodeSourceRawEnvelope(rawParts);

  const decision: IngestionResult = {
    caseNumber,
    ...(docket.placeholder === true ? { caseNumberIsPlaceholder: true } : {}),
    sourceDocumentId: urn,
    ...repairAliasesOf(row),
    court: court.name,
    country: PL_UODO_COUNTRY,
    language: PL_UODO_LANGUAGE,
    decisionDate,
    decisionType,
    // The portal files the record of the ruling and no text, and nothing
    // fetches it later, so the row takes the ordinary no-document path: kept,
    // not published. The key below is what meets the courts' own row.
    sourceUrl: documentPageUrl(urn),
    textFields: summaryOf(row),
    judges: plUodoBenchOf(row),
    metadata: checkedDecisionMetadata({
      caseNumber,
      court: court.name,
      decisionDate,
      decisionType,
      recordClass: "court-ruling",
      ...recordMetadata(row),
      courtAsPrinted: court.asPrinted,
      courtLevel: court.level,
      ...(court.era === undefined ? {} : { courtEra: court.era }),
      ...(court.branch === undefined ? {} : { courtBranch: court.branch }),
      ...(row.publicator.subtype === "sa"
        ? { docketRecognised: docket.recognised }
        : {}),
      ...(row.refname === undefined ? {} : { docketAsPrinted: row.refname }),
      ...(cbosaDocumentId === undefined ? {} : { cbosaDocumentId }),
      rulingKeys,
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_UODO],
    documentAst: EMPTY_AST,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
  return { type: "built", decision };
};

/**
 * A record in scope that states no usable URN, kept verbatim under its
 * quarantine digest rather than dropped. It is stored on its record alone:
 * with no URN there is no document address to ask, and nothing links to it.
 */
const assembleQuarantined = ({
  court,
  quarantineId,
  rawParts,
  recordClass,
  row,
}: {
  court: string;
  quarantineId: string;
  rawParts: SourceRawParts;
  recordClass: "authority-decision" | "court-ruling";
  row: PlUodoRow;
}): PlUodoBuildResult => {
  const docket = caseNumberOf(row.refname, quarantineId);
  const decisionDate = dayOf(row.time);
  const decisionType =
    recordClass === "authority-decision"
      ? PL_UODO_DECISION_TYPE
      : rulingKindOf(row.kind);
  logger.warn("case_law.ingestion.record_quarantined", {
    adapterKey: ADAPTER_KEYS.PL_UODO,
    sourceDocumentId: quarantineId,
  });
  const sourceRaw = encodeSourceRawEnvelope(rawParts);
  const decision: IngestionResult = {
    ...docket,
    sourceDocumentId: quarantineId,
    court,
    country: PL_UODO_COUNTRY,
    language: PL_UODO_LANGUAGE,
    decisionDate,
    decisionType,
    isListingOnly: true,
    textFields: summaryOf(row),
    metadata: checkedDecisionMetadata({
      caseNumber: docket.caseNumber,
      court,
      decisionDate,
      decisionType,
      recordClass,
      ...recordMetadata(row),
      detailStatus: PL_UODO_BODY_STATUS.IDENTITY_UNAVAILABLE,
      refidAsPrinted: row.refid,
    }),
    rawHash: hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_UODO],
    documentAst: EMPTY_AST,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
  return { type: "built", decision };
};

/**
 * Build one decision from the responses already in hand.
 *
 * No I/O: the crawl, the reconciliation and a replay of the stored envelope
 * all reach this with the same record and body, so none of them can key,
 * classify or parse a record differently.
 */
export const assemblePlUodoDecision = (
  options: AssemblePlUodoDecisionOptions,
): PlUodoBuildResult => {
  const { row } = options;
  const recordClass = classifyPlUodoRow(row);
  if (recordClass.type === "skipped") {
    return { type: "skipped", reason: recordClass.reason };
  }
  const identity = plUodoListingIdentity(row);
  if (identity.type !== "document") {
    return { type: "unkeyable" };
  }
  const urn = identity.sourceDocumentId;
  if (isQuarantineId(urn)) {
    return assembleQuarantined({
      court:
        recordClass.type === "authority-decision"
          ? recordClass.authority.name
          : recordClass.court.name,
      quarantineId: urn,
      rawParts: options.rawParts,
      recordClass: recordClass.type,
      row,
    });
  }
  switch (recordClass.type) {
    case "authority-decision":
      return assembleAuthorityDecision({
        ...options,
        authority: recordClass.authority,
        urn,
      });
    case "court-ruling":
      return assembleCourtRuling({
        court: recordClass.court,
        rawParts: options.rawParts,
        row,
        urn,
      });
    default: {
      recordClass satisfies never;
      return panic(`Unhandled pl-uodo record: ${JSON.stringify(recordClass)}`);
    }
  }
};

/** The envelope parts one record and its body are stored as. */
export const plUodoRawPartsOf = (
  listing: Record<string, unknown>,
  body: PlUodoBody | undefined,
): SourceRawParts => ({
  [RAW_PART.LISTING]: JSON.stringify(listing),
  ...(body === undefined ? {} : { [RAW_PART.BODY]: body.xml }),
});

type FetchPlUodoDecisionOptions = {
  cursor: string;
  listing: Record<string, unknown>;
  signal?: AbortSignal | undefined;
};

/**
 * Fetch what a listed record still needs and assemble it. Only a decision
 * needs a request: a court ruling and a skipped record are built from the
 * listing row alone.
 */
const buildPlUodoDecision = async ({
  cursor,
  listing,
  signal,
}: FetchPlUodoDecisionOptions): Promise<
  Result<PlUodoBuildResult, AdapterFetchError>
> => {
  const row = normalizePlUodoRow(listing);
  const recordClass = classifyPlUodoRow(row);
  if (recordClass.type !== "authority-decision" || !isDocumentUrn(row.refid)) {
    return Result.ok(
      assemblePlUodoDecision({
        row,
        body: undefined,
        rawParts: plUodoRawPartsOf(listing, undefined),
      }),
    );
  }
  const fetched = await fetchBody({ cursor, row, signal });
  if (Result.isError(fetched)) {
    return fetched;
  }
  const outcome = fetched.value;
  const body = outcome.type === "served" ? outcome.body : undefined;
  return Result.ok(
    assemblePlUodoDecision({
      row,
      body,
      ...(outcome.type === "absent" ? { bodyStatus: outcome.status } : {}),
      rawParts: plUodoRawPartsOf(listing, body),
    }),
  );
};

/**
 * Re-parse a stored envelope into the decision this adapter would build from
 * it today, without contacting the portal.
 */
const reparsePlUodoStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  const read = readStoredRawListing({
    stored,
    part: RAW_PART.LISTING,
    identityOf: (listing) => {
      const identity = plUodoListingIdentity(normalizePlUodoRow(listing));
      return identity.type === "document"
        ? identity.sourceDocumentId
        : undefined;
    },
  });
  if (read.type === "rejected") {
    return read;
  }
  const { listing, parts } = read;
  const row = normalizePlUodoRow(listing);
  const xml = parts[RAW_PART.BODY];
  // Why the body was absent is what the fetch learned, and a replay does not
  // fetch: the row keeps the reason it was stored with.
  const storedStatus = stored.metadata["detailStatus"];
  const built = assemblePlUodoDecision({
    row,
    body:
      xml === undefined
        ? undefined
        : plUodoBodyFrom(row, new TextEncoder().encode(xml)),
    ...(isBodyStatus(storedStatus) ? { bodyStatus: storedStatus } : {}),
    rawParts: parts,
  });
  switch (built.type) {
    case "built":
    case "detail-unavailable":
      return { type: "parsed", result: built.decision };
    case "unkeyable":
      return {
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
        detail: "the stored record states no document URN",
      };
    case "skipped":
      return {
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
        detail: `the stored record is out of scope: ${built.reason}`,
      };
    default: {
      built satisfies never;
      return panic(`Unhandled pl-uodo build result: ${JSON.stringify(built)}`);
    }
  }
};

// ── Source-field inventory ───────────────────────────────

/**
 * Every field the index record states, named by its path: a top-level key,
 * or `object.key` and `list[].key` for the structures inside it.
 */
const SOURCE_FIELDS = [
  "type",
  "version",
  "id",
  "time",
  "mtime",
  "languages",
  "name",
  "title",
  "refid",
  "refname",
  "kind",
  "parts",
  "publication",
  "publication.status",
  "publication.inforce",
  "publication.version",
  "publication.pubid",
  "publicator",
  "publicator.type",
  "publicator.subtype",
  "publicator.name",
  "publicator.country",
  "publicator.year",
  "publicator.extids",
  "publicator.volnumber",
  "publicator.docnumber",
  "publicator.pagefrom",
  "publicator.pageto",
  "dates",
  "dates[].date",
  "dates[].use",
  "dates[].type",
  "dates[].status",
  "dates[].scope",
  "dates[].text",
  "dates[].refid",
  "dates[].refname",
  "entities",
  "entities[].name",
  "entities[].title",
  "entities[].function",
  "entities[].date",
  "terms",
  "terms[].label",
  "terms[].name",
  "terms[].base",
  "terms[].scope",
  "refs",
  "refs[].refid",
  "refs[].name",
  "refs[].relation",
  "refs[].type",
  "refs[].source",
  "refs[].dest",
  "resources",
  "resources{}.ref",
  "resources{}.lang",
  "resources{}.kind",
  "resources{}.mimetype",
  "resources{}.size",
  "resources{}.checksum",
  "body",
] as const;

type PlUodoSourceField = (typeof SOURCE_FIELDS)[number];

const metadataField = (key: string): SourceFieldDisposition => ({
  disposition: "stored",
  target: { type: "metadata", key },
});

const PL_UODO_SOURCE_FIELDS = {
  type: excludedSourceField(
    "the record format's own name; every record the search returns carries the same value",
  ),
  version: excludedSourceField(
    "the version of the record format, not a fact about the document",
  ),
  id: metadataField("portalEventId"),
  time: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  mtime: metadataField("portalModifiedAt"),
  languages: metadataField("languages"),
  name: metadataField("documentName"),
  title: {
    disposition: "stored",
    target: { type: "textField", key: "summary" },
  },
  refid: { disposition: "stored", target: { type: "identity" } },
  refname: {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  kind: metadataField("documentKind"),
  parts: metadataField("parts"),
  publication: metadataField("publication"),
  "publication.status": metadataField("publication"),
  "publication.inforce": metadataField("publication"),
  "publication.version": metadataField("publication"),
  "publication.pubid": metadataField("publication"),
  publicator: metadataField("publicator"),
  "publicator.type": metadataField("publicator"),
  "publicator.subtype": metadataField("publicator"),
  "publicator.name": metadataField("publicator"),
  "publicator.country": metadataField("publicator"),
  "publicator.year": metadataField("publicator"),
  "publicator.extids": metadataField("externalIds"),
  "publicator.volnumber": metadataField("publicator"),
  "publicator.docnumber": metadataField("publicator"),
  "publicator.pagefrom": metadataField("publicator"),
  "publicator.pageto": metadataField("publicator"),
  dates: metadataField("publisherDates"),
  "dates[].date": metadataField("publisherDates"),
  "dates[].use": metadataField("publisherDates"),
  "dates[].type": metadataField("publisherDates"),
  "dates[].status": metadataField("publisherDates"),
  "dates[].scope": metadataField("publisherDates"),
  "dates[].text": metadataField("publisherDates"),
  // The link to a ruling on the document, kept as a relation of its own
  // beside the dated event that states it.
  "dates[].refid": metadataField("linkedRulings"),
  "dates[].refname": metadataField("linkedRulings"),
  entities: metadataField("entities"),
  "entities[].name": metadataField("entities"),
  "entities[].title": metadataField("entities"),
  "entities[].function": metadataField("entities"),
  "entities[].date": metadataField("entities"),
  terms: metadataField("subjectTerms"),
  "terms[].label": metadataField("subjectTerms"),
  "terms[].name": metadataField("keywords"),
  "terms[].base": metadataField("subjectTerms"),
  "terms[].scope": metadataField("subjectTerms"),
  refs: metadataField("references"),
  "refs[].refid": metadataField("references"),
  "refs[].name": {
    disposition: "stored",
    target: { type: "result", key: "publisherCitedCases" },
  },
  "refs[].relation": metadataField("references"),
  "refs[].type": metadataField("references"),
  "refs[].source": metadataField("references"),
  "refs[].dest": metadataField("references"),
  resources: metadataField("resources"),
  "resources{}.ref": metadataField("resources"),
  "resources{}.lang": metadataField("resources"),
  "resources{}.kind": metadataField("resources"),
  "resources{}.mimetype": metadataField("resources"),
  "resources{}.size": metadataField("resources"),
  "resources{}.checksum": metadataField("resources"),
  body: { disposition: "stored", target: { type: "document" } },
} as const satisfies Record<PlUodoSourceField, SourceFieldDisposition>;

/** The structures inside a record whose own keys the inventory names. */
const NESTED_OBJECTS = ["publication", "publicator"] as const;
const NESTED_LISTS = ["dates", "entities", "terms", "refs"] as const;

/**
 * What the stored record states, by path, and `body` where the envelope holds
 * the decision's body. The listing row is the portal's whole index record, so
 * a key it starts sending arrives here as a name the map has not decided.
 */
export const listPlUodoSourceFields = (
  parts: SourceRawParts,
): readonly string[] => {
  const listing = Result.try({
    try: (): unknown => JSON.parse(parts[RAW_PART.LISTING] ?? ""),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(listing)) {
    return [];
  }
  const fields = new Set(Object.keys(listing));
  for (const key of NESTED_OBJECTS) {
    const nested = listing[key];
    if (isRecord(nested)) {
      for (const inner of Object.keys(nested)) {
        fields.add(`${key}.${inner}`);
      }
    }
  }
  for (const key of NESTED_LISTS) {
    for (const item of records(listing[key])) {
      for (const inner of Object.keys(item)) {
        fields.add(`${key}[].${inner}`);
      }
    }
  }
  // Keyed by file name, which varies per record, so a resource's own keys are
  // named once for all of them.
  const resources = listing["resources"];
  if (isRecord(resources)) {
    for (const resource of Object.values(resources)) {
      if (isRecord(resource)) {
        for (const inner of Object.keys(resource)) {
          fields.add(`resources{}.${inner}`);
        }
      }
    }
  }
  if (parts[RAW_PART.BODY] !== undefined) {
    fields.add("body");
  }
  return [...fields];
};

// ── Source surfaces ──────────────────────────────────────

/**
 * Every response the portal serves about one document, and whether the row
 * keeps it. The index record and the body are kept; the rest are the same
 * record, the same body in another format, or derived from them.
 */
const SOURCE_SURFACES = [
  "listing",
  "body-xml",
  "meta",
  "title",
  "toc",
  "search-index",
  "body-html",
  "body-text",
  "body-pdf",
  "event-archive",
  "summary",
  "dates",
  "refs",
  "units",
  "human-page",
] as const;

const PL_UODO_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface(RAW_PART.LISTING),
    "body-xml": storedSourceSurface(RAW_PART.BODY),
    meta: excludedSourceSurface(
      "the same index record the search already returns in full as the listing row",
    ),
    title: excludedSourceSurface(
      "the name and title the listing row already states",
    ),
    toc: excludedSourceSurface(
      "a table of contents the portal derives from the body the row keeps",
    ),
    "search-index": excludedSourceSurface(
      "the portal's full-text index of the kept body, and the subject codes the listing row states",
    ),
    "body-html": excludedSourceSurface("a rendering of the kept body XML"),
    "body-text": excludedSourceSurface("a rendering of the kept body XML"),
    "body-pdf": excludedSourceSurface(
      "a rendering of the kept body XML; the row links it as the document address",
    ),
    "event-archive": excludedSourceSurface(
      "an archive of the index record, body, table of contents and search index above",
    ),
    summary: excludedSourceSurface(
      "the portal answers 404 for this content kind on its documents; the record's title is kept as the summary",
    ),
    dates: excludedSourceSurface(
      "answers 404 on its own; the listing row states every date",
    ),
    refs: excludedSourceSurface(
      "answers 404 on its own; the listing row states every reference",
    ),
    units: excludedSourceSurface(
      "answers 404 on its own; the body XML holds the structure",
    ),
    "human-page": excludedSourceSurface(
      "the page shell the row records as its source address; it renders the record and the body",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Crawl cursor ─────────────────────────────────────────

/**
 * `<mtime ms>:<event id>`: the modification time and the id of the last
 * record read, or an empty id before any record at that time was read.
 */
const CURSOR_PATTERN =
  /^(?<mtime>\d{1,15}):(?<after>PublicDocument-\d{8}-\d{6}-\d{3}-[0-9a-f]{32})?(?::(?<parked>\d{4}-\d{2}-\d{2}))?$/u;

/**
 * Where the crawl stands, as a keyset over `(mtime, id)`: every record at or
 * before it has been read. A keyset rather than an offset, because the set
 * the portal answers moves under an offset — a record read earlier that the
 * portal modifies again leaves it, and every position after shifts — and a
 * record at a position the offset has passed is then never read.
 */
export type PlUodoCursor = {
  mtimeMs: number;
  /** The last record read at `mtimeMs`; undefined reads that time whole. */
  afterId: string | undefined;
  /**
   * The UTC day a lap last reached the tip, which parks the crawl until that
   * day has closed; undefined while there is more to read.
   */
  parkedOn?: string | undefined;
};

const todayUtc = (): string => Temporal.Now.plainDateISO("UTC").toString();

export const parsePlUodoCursor = (cursor: string | null): PlUodoCursor => {
  const groups =
    cursor === null ? undefined : CURSOR_PATTERN.exec(cursor)?.groups;
  const mtimeMs = Number(groups?.["mtime"]);
  if (!Number.isSafeInteger(mtimeMs)) {
    return { mtimeMs: 0, afterId: undefined };
  }
  const parked = groups?.["parked"];
  return {
    mtimeMs,
    afterId: groups?.["after"],
    ...(parked !== undefined && parsePlainDate(parked) !== null
      ? { parkedOn: parked }
      : {}),
  };
};

export const encodePlUodoCursor = ({
  afterId,
  mtimeMs,
  parkedOn,
}: PlUodoCursor): string =>
  `${mtimeMs}:${afterId ?? ""}${parkedOn === undefined ? "" : `:${parkedOn}`}`;

const mtimeMsOf = (mtime: string | undefined): number | undefined => {
  if (mtime === undefined) {
    return undefined;
  }
  const epoch = Result.try({
    try: () => Temporal.Instant.from(mtime).epochMilliseconds,
    catch: () => undefined,
  }).unwrapOr(undefined);
  return epoch !== undefined && Number.isSafeInteger(epoch) ? epoch : undefined;
};

/** Whether a record's key sorts strictly after the cursor's. */
const isAfter = (
  cursor: PlUodoCursor,
  mtimeMs: number,
  id: string,
): boolean => {
  if (mtimeMs !== cursor.mtimeMs) {
    return mtimeMs > cursor.mtimeMs;
  }
  return cursor.afterId === undefined || id > cursor.afterId;
};

/**
 * The cursor after a page of records, which the portal returned ordered by
 * `(mtime, id)`. `undefined` where a record states no readable time or id,
 * or where the keys do not rise strictly past the cursor: a keyset built over
 * either could pass a record unseen, so the page fails instead.
 */
export const nextPlUodoCursor = (
  cursor: PlUodoCursor,
  rows: readonly PlUodoRow[],
): PlUodoCursor | undefined => {
  let position: PlUodoCursor = {
    mtimeMs: cursor.mtimeMs,
    afterId: cursor.afterId,
  };
  for (const row of rows) {
    const rowMs = mtimeMsOf(row.mtime);
    const { id } = row;
    if (
      rowMs === undefined ||
      id === undefined ||
      !EVENT_ID.test(id) ||
      !isAfter(position, rowMs, id)
    ) {
      return undefined;
    }
    position = { mtimeMs: rowMs, afterId: id };
  }
  return position;
};

const crawlQuery = (condition: string): SearchQuery => ({
  timespan: ",",
  condition,
  count: CRAWL_PAGE_SIZE,
  from: 0,
  order: "+mtime,+id",
  fields: LISTING_FIELDS,
});

/**
 * The searches that list what follows the cursor, in keyset order. The search
 * ANDs its conditions and has no OR, so `(mtime, id) > (t, i)` is asked as
 * the rest of time `t` after `i`, then everything after `t`.
 */
const crawlConditions = (cursor: PlUodoCursor): string[] =>
  cursor.afterId === undefined
    ? [`mtime:ge:${cursor.mtimeMs}`]
    : [
        `mtime:eq:${cursor.mtimeMs}/id:gt:${cursor.afterId}`,
        `mtime:gt:${cursor.mtimeMs}`,
      ];

// ── Reconciliation ───────────────────────────────────────

const SLICE_YEAR = /^\d{4}$/u;

const sliceYear = (slice: string): number =>
  SLICE_YEAR.test(slice)
    ? Number(slice)
    : panic(`pl-uodo slice is not a four-digit year: ${slice}`);

const yearOf = (now: Date): string =>
  String(
    Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(
      "UTC",
    ).year,
  );

const nextSlice = (slice: string): string | null => {
  const next = sliceYear(slice) + 1;
  return next > Temporal.Now.plainDateISO("UTC").year ? null : String(next);
};

const previousSlice = (slice: string): string | null => {
  const previous = String(sliceYear(slice) - 1);
  return previous < PL_UODO_FIRST_SLICE ? null : previous;
};

export const plUodoSliceQuery = (slice: string, page: number): SearchQuery => {
  const year = sliceYear(slice);
  return {
    timespan: `${year}-01-01,${year}-12-31`,
    count: LISTING_PAGE_SIZE,
    from: page * LISTING_PAGE_SIZE,
    order: "+id",
    fields: LISTING_FIELDS,
  };
};

/**
 * One page of the records filed under a decision year, the ones this adapter
 * ingests. The search states no total, so a full page reports one more; the
 * walk ends where the portal serves a short page.
 */
const listPlUodoSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const listed = await search({
    cursor: slice,
    query: plUodoSliceQuery(slice, page),
    signal,
  });
  if (Result.isError(listed)) {
    // Reported through the promise: the engine keeps the slice's previous
    // ledger row on a rejection, and would settle the slice over the outage
    // if a refusal came back as a page.
    return await Promise.reject(listed.error);
  }
  const { rows: listing, served } = listed.value;
  const rows = listing.map((payload) => ({
    payload,
    row: normalizePlUodoRow(payload),
  }));
  reportSkips(
    `slice ${slice} page ${page}`,
    tallyPlUodoSkips(rows.map(({ row }) => row)),
  );
  const items = rows.flatMap(({ payload, row }) =>
    classifyPlUodoRow(row).type === "skipped"
      ? []
      : [{ identity: plUodoListingIdentity(row), payload }],
  );
  if (served === 0) {
    return { items, totalPages: page };
  }
  return {
    items,
    totalPages: served < LISTING_PAGE_SIZE ? page + 1 : page + 2,
  };
};

/**
 * Rebuild a decision from a record the loop stored verbatim. Renormalized
 * rather than trusted: it may have been parked for days.
 */
const buildPlUodoFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isRecord(payload)) {
    return { type: "unkeyable" };
  }
  const attempted = await buildPlUodoDecision({
    cursor: nonEmpty(payload["refid"]) ?? "",
    listing: payload,
    ...(signal === undefined ? {} : { signal }),
  });
  if (Result.isError(attempted)) {
    return await Promise.reject(attempted.error);
  }
  const built = attempted.value;
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "unkeyable":
    case "skipped":
      return { type: "unkeyable" };
    case "detail-unavailable":
      // Storing the record alone would make the identity held while its body
      // stayed unread, and the decision would leave every later walk.
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled pl-uodo build result: ${JSON.stringify(built)}`);
    }
  }
};

// ── Total ────────────────────────────────────────────────

/**
 * Every field classifying and keying a record reads: the publisher kind, the
 * signing line an authority decision is recognised by, and what the
 * quarantine digest is taken over. The search returns only what `fields`
 * names, so one missing here is a whole class counted as nothing.
 */
const TOTAL_PROBE_FIELDS =
  "refid,refname,time,kind,name,title,publicator,entities";

/**
 * How many records the portal holds that this adapter ingests: every record,
 * listed by publisher alone in one request, classified the way the crawl
 * classifies it.
 */
const countPlUodoRecords = async (
  signal: AbortSignal,
): Promise<SourceTotalCount> => {
  const listed = await search({
    cursor: "total",
    query: {
      timespan: ",",
      count: TOTAL_PROBE_COUNT,
      from: 0,
      fields: TOTAL_PROBE_FIELDS,
    },
    signal,
  });
  if (Result.isError(listed)) {
    return listed.error.httpStatus === undefined
      ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD)
      : sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
  }
  const { rows, served } = listed.value;
  if (served >= TOTAL_PROBE_COUNT) {
    return sourceTotalProbeFailed(
      SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
    );
  }
  const ingested = rows
    .map(normalizePlUodoRow)
    .filter(
      (row) =>
        classifyPlUodoRow(row).type !== "skipped" &&
        plUodoListingIdentity(row).type === "document",
    );
  return sourceTotalRead(ingested.length);
};

// ── Crawl ────────────────────────────────────────────────

const plUodoFetchPage = async (
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const position = parsePlUodoCursor(cursor);
  const encoded = encodePlUodoCursor(position);
  // Parked on a day that has not closed: this cycle has nothing to ask.
  if (position.parkedOn !== undefined && position.parkedOn >= todayUtc()) {
    return Result.ok({ decisions: [], nextCursor: encoded });
  }
  const listing: Record<string, unknown>[] = [];
  let url = "";
  for (const condition of crawlConditions(position)) {
    const listed = await search({
      cursor: encoded,
      query: crawlQuery(condition),
      signal,
    });
    if (Result.isError(listed)) {
      return listed;
    }
    url = listed.value.url;
    listing.push(...listed.value.rows);
    if (listing.length >= CRAWL_PAGE_SIZE) {
      break;
    }
  }
  listing.splice(CRAWL_PAGE_SIZE);
  const rows = listing.map(normalizePlUodoRow);
  const next = nextPlUodoCursor(position, rows);
  if (next === undefined) {
    return Result.err(
      publisherError(
        encoded,
        "the search answered records out of modification order",
      ),
    );
  }
  reportSkips(`crawl ${encoded}`, tallyPlUodoSkips(rows));

  const decisions: IngestionResult[] = [];
  for (const payload of listing) {
    if (signal?.aborted) {
      // The cycle stopped partway through the page, so it says nothing about
      // the records it never reached; the page is read again next cycle, and
      // what was stored is stored again under the same hash.
      return Result.ok({ decisions, sourceUrl: url, nextCursor: encoded });
    }
    const attempted = await buildPlUodoDecision({
      cursor: encoded,
      listing: payload,
      signal,
    });
    if (Result.isError(attempted)) {
      return attempted;
    }
    const built = attempted.value;
    switch (built.type) {
      // Counted above, by reason.
      case "skipped":
        break;
      // A record stating neither a URN nor anything to fingerprint: nothing
      // can key it, and the report is what keeps it from being a silence.
      case "unkeyable":
        logger.warn("case_law.ingestion.record_unidentifiable", {
          adapterKey: ADAPTER_KEYS.PL_UODO,
          cursor: encoded,
        });
        break;
      // The cursor moves past the record either way, so the crawl keeps the
      // row a decision without a body still describes; only the
      // reconciliation refuses it.
      case "detail-unavailable":
      case "built":
        decisions.push(built.decision);
        break;
      default: {
        built satisfies never;
        panic(`Unhandled pl-uodo build result: ${JSON.stringify(built)}`);
      }
    }
  }

  // A short page is the tip: the crawl parks there until today has closed.
  const reachedTip = listing.length < CRAWL_PAGE_SIZE;
  return Result.ok({
    decisions,
    sourceUrl: url,
    nextCursor: encodePlUodoCursor(
      reachedTip ? { ...next, parkedOn: todayUtc() } : next,
    ),
  });
};

// ── Adapter ──────────────────────────────────────────────

export const plUodoAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.PL_UODO,
  language: PL_UODO_LANGUAGE,
  minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  // One search plus a body request per decision, behind the one-second gate.
  pageTimeoutMs: 120_000,
  maxSyncPages: 10,

  reparseStoredRaw: reparsePlUodoStoredRaw,

  sourceSurfaces: PL_UODO_SOURCE_SURFACES,

  sourceFields: {
    status: "declared",
    fields: PL_UODO_SOURCE_FIELDS,
    listSourceFields: listPlUodoSourceFields,
  },

  getTotalCount: countPlUodoRecords,

  reconciliation: {
    firstSlice: PL_UODO_FIRST_SLICE,
    sliceOf: yearOf,
    nextSlice,
    previousSlice,
    tipWindowDays: PL_UODO_TIP_WINDOW_SLICES,
    // A decision whose body failed leaves a record-only row; unset, that row
    // would count as held and its body would never be asked for again.
    heldRequiresDetail: true,
    // A court ruling is stored without a document by design, under the same
    // marker, so it counts as held on its record alone.
    heldWithoutDetail: plUodoHeldWithoutDetail,
    listSlicePage: listPlUodoSlicePage,
    buildDecision: buildPlUodoFromPayload,
  },

  /**
   * The page's own refusals come back as `Err`; this wrapper is for what the
   * fetch layer raises instead — a dropped connection, an exhausted retry
   * budget, a cycle abort.
   */
  async fetchPage(cursor, _config, signal) {
    return Result.flatten(
      await Result.tryPromise({
        try: async () => await plUodoFetchPage(cursor, signal),
        catch: adapterCatch(ADAPTER_KEYS.PL_UODO, cursor),
      }),
    );
  },
});
