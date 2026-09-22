import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import { splitCaseReference } from "@/api/handlers/case-law/case-number";
import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  decodeSourceRawEnvelope,
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  STORED_RAW_REPARSE_REJECTION,
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
  StoredRawReparseInput,
  StoredRawReparseOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createCalendarDaySliceWalk } from "@/api/handlers/case-law/ingestion/adapters/calendar-day-slice-walk";
import {
  fetchPublisher,
  fetchWithRetry,
} from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  isArrayOf,
  isNullishArrayOf,
  isNullishNumber,
  isNullishString,
  isNullishValue,
  isTimeoutError,
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseRegionalDecision } from "@/api/handlers/case-law/ingestion/parsers/cz-regional";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import { stripAcademicTitles } from "@/api/handlers/case-law/judges/judge-name";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  checkedDecisionMetadata,
} from "@/api/lib/case-law/decision-text";
import { addUtcDays } from "@/api/lib/dates";
import {
  AdapterFetchError,
  FetchBoundaryError,
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import type { UnpersistableDecisionField } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { restrictCzRegionalFinaldocUrl } from "@/api/lib/legal-search/cz-regional-finaldoc-url";
import { logger } from "@/api/lib/observability/logger";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

/**
 * Czech Regional Courts adapter.
 *
 * Fetches decisions from the rozhodnuti.justice.cz open data
 * JSON API. The API uses a hierarchical date structure:
 *
 *   /api/opendata/{year}/{month}/{day}?page={n}
 *
 * Each day may contain multiple pages (100 items/page).
 * Fulltext is not inline; a separate /api/finaldoc/{uuid}
 * endpoint provides the full document.
 *
 * Cursor format: "YYYY-MM-DD:page" (e.g. "2026-03-01:0").
 * Pages are 0-indexed. A null cursor starts from 30 days ago.
 */

const BASE_URL = "https://rozhodnuti.justice.cz/api";

/** The only language this source publishes; half of the fallback identity. */
export const CZ_REGIONAL_LANGUAGE = "cs";

/** First day of the publisher's open-data feed. */
export const CZ_REGIONAL_FEED_START =
  ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_REGIONAL].dateRange.fromInclusive;

/**
 * Days near the tip that the reconciliation re-walks on a fast cadence. The
 * publisher backfills a day after first listing it, so a day walked the hour
 * it opened is not final; a fortnight is long enough for those late arrivals
 * and short enough that the fast lane stays a fixed, small amount of work.
 */
const CZ_REGIONAL_TIP_WINDOW_DAYS = 14;

/**
 * Concurrent finaldoc fetches per page. The court server
 * returns 429 when overloaded (handled with a 2s backoff),
 * so we can safely push higher concurrency and self-correct.
 */
const FINALDOC_CONCURRENCY = 15;

const arrayOrEmpty = <T>(value: T[] | null | undefined): T[] => {
  if (value === undefined || value === null) {
    return [];
  }
  return value;
};
const LIST_FETCH_RETRIES = 2;
const LIST_FETCH_RETRY_DELAY_MS = 5000;

/** The envelope part each response this source serves is kept as. */
const RAW_PART = {
  LISTING: "listing",
  DOCUMENT: "document",
  CHAIN: "chain",
} as const;

/**
 * The stored envelope with the chain part added, which is the only change the
 * chain pass makes to a payload it did not build.
 *
 * Here rather than in the pass because the part name is this adapter's, and
 * because the enrolled fixture builds its row through the same call: the
 * `chain` part reaches a stored envelope this way and no other, so evidence
 * that the part is recorded comes through the assembly the pass uses rather
 * than through a payload written by hand.
 */
export const czRegionalEnvelopeWithChain = (
  parts: SourceRawParts,
  chainRaw: string,
): string => encodeSourceRawEnvelope({ ...parts, [RAW_PART.CHAIN]: chainRaw });

/**
 * Whether the chain has been read for a row, stated on the row itself.
 *
 * Selectable, because it is what the chain pass walks: a row nothing has
 * asked about carries no such key, and one the publisher answered for carries
 * the list it answered with — empty where nothing affects the decision.
 */
export const CZ_REGIONAL_AFFECTING_DOCS_METADATA_KEY = "affectingDocs";

/**
 * What the publisher prints in `soud` for a record no court decided, and the
 * court code the document payload carries for the same record.
 *
 * The feed mixes the ministry's own administrative decisions — insolvency
 * administrator licences and the like — in with the court decisions, and
 * states both markers on them. They are not court decisions and their
 * identifier is not an ECLI, so they are refused at the boundary rather than
 * stored as a court's judgment.
 */
const COURT_NOT_STATED = "(nezadán)";
const COURT_CODE_NONE = "NONE";

/**
 * The decision types this API accepts, in the publisher's own Czech.
 *
 * `ORDER_T` is the value the API answers to; a plain `ORDER` is rejected with
 * HTTP 400, so the entry that once mapped it never fired and its documents
 * were stored under the enum member lowercased. The type is what the local
 * heading is synthesized from, so the mapping is the whole difference between
 * a document that opens with its own title and one that does not.
 *
 * Read through {@link mapDecisionType}, which reports a member this map has
 * never seen instead of lowercasing it into the corpus unnoticed.
 */
const DECISION_TYPE_MAP: Readonly<Record<string, string>> = {
  JUDGEMENT: "rozsudek",
  RESOLUTION: "usnesení",
  ORDER_T: "trestní příkaz",
};

const mapDecisionType = (
  type: string | undefined,
  caseNumber: string,
): string | undefined => {
  if (!type) {
    return undefined;
  }
  const mapped = DECISION_TYPE_MAP[type];
  if (mapped !== undefined) {
    return mapped;
  }
  // A member nothing maps reaches the corpus as the enum lowercased, which no
  // reader and no heading lookup recognises. The row is still worth storing,
  // so the miss is reported rather than dropped.
  logger.warn("case_law.ingestion.decision_type_unmapped", {
    adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
    caseNumber,
    decisionTypeRaw: type,
  });
  return type.toLowerCase();
};

/** Shape of a single item in the paginated day response. */
export type CzRegionalApiItem = {
  jednaciCislo?: string | null;
  ecli?: string | null;
  soud?: string | null;
  autor?: string | null;
  predmetRizeni?: string | null;
  datumVydani?: string | null;
  datumZverejneni?: string | null;
  klicovaSlova?: string[] | null;
  zminenaUstanoveni?: string[] | null;
  odkaz?: string | null;
};

/** Paginated response from /api/opendata/{y}/{m}/{d}. */
type CzRegionalPageResponse = {
  items?: CzRegionalApiItem[] | null;
  totalPages?: number | null;
  pageNumber?: number | null;
};

/** Paragraph shape within finaldoc structured sections. */
type FinaldocParagraph = {
  texts: { text: string; anonStyle: string }[];
  styleLocalId: number;
  tableCellInfo: unknown;
};

/** Style definition within finaldoc. */
type FinaldocStyle = {
  localId: number;
  alignment: string;
  hasSpaceBefore: boolean;
  hasSpaceAfter: boolean;
  bold: boolean;
  italic: boolean;
};

/**
 * The docket as the publisher decomposes it: the registry letter is the
 * agenda (`C` civil, `T` criminal, `Co` civil appeal, …) and the page number
 * is the sheet the listing appends to the printed reference.
 */
type FinaldocCaseNumber = {
  senate?: number | null;
  registry?: string | null;
  index?: number | null;
  year?: number | null;
  pageNumber?: number | null;
};

/**
 * One edge of the publisher's own decision graph: what this decision did to
 * an earlier one (`affectedDocs`, inside the document payload) or what a later
 * one did to it (the chain endpoint, which also states the counterpart's id).
 */
type FinaldocRelation = {
  uuid?: string | null;
  caseNumber?: FinaldocCaseNumber | null;
  courtCode?: string | null;
  affectedDate?: string | null;
  affectedTypes?: string[] | null;
  url?: string | null;
};

/** Response shape from /api/finaldoc/{uuid}. */
type CzRegionalFinaldoc = {
  uuid?: string | null;
  verdictText?: string | null;
  justificationText?: string | null;
  header?: FinaldocParagraph[] | null;
  verdict?: FinaldocParagraph[] | null;
  justification?: FinaldocParagraph[] | null;
  information?: FinaldocParagraph[] | null;
  styles?: FinaldocStyle[] | null;
  metadata?: {
    type?: string | null;
    ecli?: string | null;
    publishedAt?: string | null;
    decisionAt?: string | null;
    caseNumber?: FinaldocCaseNumber | null;
    solver?: unknown;
    courtCode?: unknown;
    caseResultType?: string | string[] | null;
    caseSubject?: string | null;
    specialType?: string[] | null;
    affectedDocs?: unknown;
    regulations?: unknown[] | null;
    flags?: string[] | null;
    [key: string]: unknown;
  } | null;
};

const isOptionalStringArray = (
  value: unknown,
): value is string[] | null | undefined =>
  value === undefined ||
  value === null ||
  isArrayOf(value, (item): item is string => typeof item === "string");

const isFinaldocText = (
  value: unknown,
): value is { text: string; anonStyle: string } =>
  isRecord(value) &&
  typeof value["text"] === "string" &&
  typeof value["anonStyle"] === "string";

const isFinaldocParagraph = (value: unknown): value is FinaldocParagraph =>
  isRecord(value) &&
  isArrayOf(value["texts"], isFinaldocText) &&
  typeof value["styleLocalId"] === "number" &&
  "tableCellInfo" in value;

/**
 * One entry of the chain endpoint's array.
 *
 * Lenient like the document validator above and for the same reason: an entry
 * whose shape drifted is still stored verbatim as the `chain` part, so the
 * envelope is what protects the fields, not this guard.
 */
const isFinaldocRelation = (value: unknown): value is FinaldocRelation =>
  isRecord(value) && isNullishString(value["uuid"]);

const isFinaldocStyle = (value: unknown): value is FinaldocStyle =>
  isRecord(value) &&
  typeof value["localId"] === "number" &&
  typeof value["alignment"] === "string" &&
  typeof value["hasSpaceBefore"] === "boolean" &&
  typeof value["hasSpaceAfter"] === "boolean" &&
  typeof value["bold"] === "boolean" &&
  typeof value["italic"] === "boolean";

/**
 * Metadata validation is intentionally lenient: the court API
 * evolves field types without notice (solver: string -> object,
 * caseResultType: string -> string[], regulations: string[] ->
 * object[]). Since metadata lands in an untyped JSONB column,
 * we only require it to be a record and check `type` (needed
 * for decision type mapping). The three keys a row is built from
 * (`solver`, `courtCode`, `affectedDocs`) are `unknown` on the type and read
 * only through {@link solverJudges}, {@link isCourtDocument} and
 * {@link publisherCitedCasesOf}.
 */
const isCzRegionalMetadata = (
  value: unknown,
): value is NonNullable<CzRegionalFinaldoc["metadata"]> =>
  isRecord(value) && isNullishString(value["type"]);

const isCzRegionalFinaldoc = (value: unknown): value is CzRegionalFinaldoc =>
  isRecord(value) &&
  isNullishString(value["uuid"]) &&
  isNullishString(value["verdictText"]) &&
  isNullishString(value["justificationText"]) &&
  isNullishArrayOf(value["header"], isFinaldocParagraph) &&
  isNullishArrayOf(value["verdict"], isFinaldocParagraph) &&
  isNullishArrayOf(value["justification"], isFinaldocParagraph) &&
  isNullishArrayOf(value["information"], isFinaldocParagraph) &&
  isNullishArrayOf(value["styles"], isFinaldocStyle) &&
  isNullishValue(value["metadata"], isCzRegionalMetadata);

export const isCzRegionalApiItem = (
  value: unknown,
): value is CzRegionalApiItem =>
  isRecord(value) &&
  isNullishString(value["jednaciCislo"]) &&
  isNullishString(value["ecli"]) &&
  isNullishString(value["soud"]) &&
  isNullishString(value["autor"]) &&
  isNullishString(value["predmetRizeni"]) &&
  isNullishString(value["datumVydani"]) &&
  isNullishString(value["datumZverejneni"]) &&
  isOptionalStringArray(value["klicovaSlova"]) &&
  isOptionalStringArray(value["zminenaUstanoveni"]) &&
  isNullishString(value["odkaz"]);

const isCzRegionalPageResponse = (
  value: unknown,
): value is CzRegionalPageResponse =>
  isRecord(value) &&
  isNullishArrayOf(value["items"], isCzRegionalApiItem) &&
  isNullishNumber(value["totalPages"]) &&
  isNullishNumber(value["pageNumber"]);

/**
 * One decision's document payload, as served and as read.
 *
 * The bytes are kept whatever the validator makes of them: a shape this
 * adapter no longer recognises is still the publisher's own statement about
 * the decision, and storing it is what makes the next parser free.
 */
type CzRegionalDocumentPayload = {
  raw: string;
  parsed: CzRegionalFinaldoc | null;
};

/** The chain payload for one decision, as served and as read. */
type CzRegionalChainPayload = {
  raw: string;
  entries: readonly FinaldocRelation[];
};

const parsedJson = (raw: string): unknown =>
  Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);

/**
 * A document response as the part the assembler takes.
 *
 * The bytes and the validated shape travel together, and a payload the
 * validator rejects still becomes a part: the response is the publisher's
 * statement about the decision whatever this adapter can read of it.
 */
export const readCzRegionalDocument = (
  raw: string,
): CzRegionalDocumentPayload => {
  const parsed = parsedJson(raw);
  return { raw, parsed: isCzRegionalFinaldoc(parsed) ? parsed : null };
};

/** A chain response as its part, or null where it is not the array served. */
export const readCzRegionalChain = (
  raw: string,
): CzRegionalChainPayload | null => {
  const parsed = parsedJson(raw);
  return isUnknownArray(parsed)
    ? { raw, entries: parsed.filter(isFinaldocRelation) }
    : null;
};

/**
 * Fetch the document payload from /api/finaldoc/{uuid}.
 *
 * Returns the bytes and the validated shape separately, so the caller stores
 * the response it was served rather than whatever the validator could make of
 * it. `null` means nothing came back at all, which is the one case the caller
 * has to tell apart: a listed decision whose document was never read must not
 * be stored as held.
 */
const fetchFinaldoc = async (
  docUrl: string,
  caseNumber: string,
  signal?: AbortSignal,
): Promise<CzRegionalDocumentPayload | null> => {
  const target = restrictCzRegionalFinaldocUrl(docUrl);
  if (target === null) {
    logger.warn("case_law.ingestion.outbound_url_rejected", {
      adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
      caseNumber,
    });
    return null;
  }

  try {
    const response = await fetchWithRetry(
      target.toString(),
      {
        headers: { Accept: "application/json" },
        redirect: "error",
      },
      {
        maxRetries: 1,
        signal,
        adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
      },
    );

    if (!response.ok) {
      return null;
    }

    const payload = readCzRegionalDocument(
      JSON.stringify(await response.json()),
    );
    if (payload.parsed === null) {
      // Per-document publisher-side shape drift is operational: the raw
      // response is preserved for re-parsing, so the miss is logged rather
      // than captured per document.
      logger.warn("case_law.ingestion.finaldoc_validation_failed", {
        adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
        caseNumber,
        docUrl: target.toString(),
      });
    }
    return payload;
  } catch {
    return null;
  }
};

/**
 * Fetch the documents that later affected this one, from
 * `/api/finalDocChain/affectingDocs/{uuid}`.
 *
 * The inverse of the document payload's own `affectedDocs`, and the only
 * surface that states the counterpart's publisher id, so the graph resolves
 * without matching court and docket text. It costs one request per decision,
 * which is why the crawl does not make it: the chain pass in
 * `cz-regional-chain-backfill.ts` spends that budget under an operator and
 * writes the part onto rows already held.
 */
export const fetchCzRegionalAffectingDocs = async (
  sourceDocumentId: string,
  signal?: AbortSignal,
): Promise<CzRegionalChainPayload | null> => {
  const response = await fetchPublisher(
    `${BASE_URL}/finalDocChain/affectingDocs/${encodeURIComponent(sourceDocumentId)}`,
    {
      adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
      ...(signal === undefined ? {} : { signal }),
      headers: {
        Accept: "application/json",
        "User-Agent": INGESTION_USER_AGENT,
      },
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    },
  );
  if (!response.ok) {
    return null;
  }
  return readCzRegionalChain(JSON.stringify(await response.json()));
};

/**
 * The docket as the publisher prints it, rebuilt from the parts it states.
 *
 * A relation names the counterpart by its parts alone and a citation names a
 * docket, so the edge is unusable until the two are spelled the same way. The
 * sheet number is deliberately left off: it identifies a page of the file,
 * not the decision.
 */
const formatCaseNumberParts = (parts: unknown): string | undefined => {
  if (!isRecord(parts)) {
    return undefined;
  }
  const { senate, registry, index, year } = parts;
  if (
    typeof senate !== "number" ||
    typeof index !== "number" ||
    typeof year !== "number" ||
    typeof registry !== "string" ||
    registry.length === 0
  ) {
    return undefined;
  }
  return `${senate} ${registry} ${index}/${year}`;
};

/**
 * The judge this source names, as one rapporteur.
 *
 * The publisher states exactly one person per decision and publishes no
 * separate opinions, so `dissenting` is unreachable here. The Czech word it
 * prints beside the name — `samosoudkyně` for a judge sitting alone,
 * `předsedkyně senátu` for a panel chair — says how that one judge sat, not
 * that a second bench role exists, so it stays on `metadata.solver` with the
 * rest of the verbatim blob rather than becoming a role of its own.
 */
const solverJudges = (solver: unknown): readonly DecisionJudgeInput[] => {
  const printed = solverNameAsPrinted(solver);
  return printed.length === 0
    ? []
    : [{ role: DECISION_JUDGE_ROLE.RAPPORTEUR, nameAsPrinted: printed }];
};

/** The name parts of a structured solver that make up the printed name. */
const SOLVER_NAME_PARTS = ["firstName", "lastName"] as const;

/**
 * The solver as a flat string (the older shape) or as a record of name parts.
 * A part the publisher sends as `null` is one it leaves empty; any other
 * shape is refused as the field it is, rather than left to a `.trim()` that
 * throws a bare `TypeError`.
 */
const solverNameAsPrinted = (solver: unknown): string => {
  if (typeof solver === "string") {
    return stripAcademicTitles(solver);
  }
  if (!isRecord(solver)) {
    throw refusedMetadata("solver");
  }
  return SOLVER_NAME_PARTS.flatMap((key) => {
    const part = solver[key];
    if (part === undefined || part === null) {
      return [];
    }
    if (typeof part !== "string") {
      throw refusedMetadata("solver");
    }
    return part.trim().length === 0 ? [] : [part];
  }).join(" ");
};

/** The same judge as the listing row pre-joins them, titles and all. */
const listingJudges = (
  author: string | undefined,
): readonly DecisionJudgeInput[] => {
  const printed = author === undefined ? "" : stripAcademicTitles(author);
  return printed.length === 0
    ? []
    : [{ role: DECISION_JUDGE_ROLE.RAPPORTEUR, nameAsPrinted: printed }];
};

/**
 * Whether the publisher states a court decided this record.
 *
 * The feed carries the ministry's own administrative decisions beside the
 * courts', marked by a court field reading "not entered" and, in the document
 * payload, a court code of `NONE`. Their identifier is a ministry reference
 * rather than an ECLI, so storing one makes a case-law row whose court is a
 * placeholder and whose ECLI is not one. Refusing them here keeps them out of
 * the corpus and out of what reconciliation counts as missing.
 */
const isCourtListing = (item: CzRegionalApiItem): boolean =>
  Boolean(item.soud) && item.soud?.trim() !== COURT_NOT_STATED;

const isCourtDocument = (doc: CzRegionalFinaldoc | null): boolean => {
  const courtCode = doc?.metadata?.courtCode;
  if (courtCode === undefined || courtCode === null) {
    return true;
  }
  // A code that is not a string cannot say whether a court decided the
  // record, so the row is refused rather than stored as a court's.
  if (typeof courtCode !== "string") {
    throw refusedMetadata("courtCode");
  }
  return courtCode.trim() !== COURT_CODE_NONE;
};

/**
 * The publisher's own outgoing edges, spelled as dockets. `null` states no
 * edges; a list holding anything but relation records is refused rather than
 * dereferenced.
 */
const publisherCitedCasesOf = (affectedDocs: unknown): string[] => {
  if (affectedDocs === undefined || affectedDocs === null) {
    return [];
  }
  if (!isUnknownArray(affectedDocs)) {
    throw refusedMetadata("affectedDocs");
  }
  return affectedDocs.flatMap((relation) => {
    if (!isRecord(relation)) {
      throw refusedMetadata("affectedDocs");
    }
    const cited = formatCaseNumberParts(relation["caseNumber"]);
    return cited === undefined ? [] : [cited];
  });
};

/** The field each document metadata key a row is built from is refused as. */
const CHECKED_METADATA_FIELDS = {
  solver: UNPERSISTABLE_DECISION_FIELDS.JUDGE_NAME,
  courtCode: UNPERSISTABLE_DECISION_FIELDS.COURT_CODE,
  affectedDocs: UNPERSISTABLE_DECISION_FIELDS.PUBLISHER_CITATIONS,
} as const satisfies Record<string, UnpersistableDecisionField>;

const refusedMetadata = (
  key: keyof typeof CHECKED_METADATA_FIELDS,
): UnpersistableDecisionFieldError =>
  new UnpersistableDecisionFieldError({
    message: `CZ regional metadata.${key} is not in a shape the publisher states`,
    field: CHECKED_METADATA_FIELDS[key],
  });

/**
 * The publisher's document id, which this source states only as the last
 * segment of the item's link (`/api/finaldoc/<id>`). Returns undefined for a
 * link that carries no segment, so identity falls back to the case number
 * rather than keying every such row on the same empty string.
 */
export const documentIdFromLink = (
  link: string | undefined,
): string | undefined => {
  if (link === undefined) {
    return undefined;
  }
  const id = /\/(?<id>[^/?#]+)\/*(?:[?#]|$)/u.exec(link)?.groups?.["id"];
  return id !== undefined && isPersistableSourceDocumentId(id) ? id : undefined;
};

/**
 * The identity the ingest would store for this listing item.
 *
 * Stated once, here, rather than restated by every caller that has to decide
 * whether a listed item is already held: the crawl, the reconciliation loop
 * and the operator repair all key rows the same way, and a second copy of the
 * rule would let them disagree about which rows exist.
 */
export const czRegionalListingIdentity = (
  item: CzRegionalApiItem,
): ListingIdentity => {
  if (!item.jednaciCislo || !isCourtListing(item)) {
    return { type: "unidentifiable" };
  }
  const sourceDocumentId = documentIdFromLink(item.odkaz ?? undefined);
  if (sourceDocumentId !== undefined) {
    return { type: "document", sourceDocumentId };
  }
  return {
    type: "case-number",
    caseNumber: splitCaseReference(item.jednaciCislo).caseNumber,
    language: CZ_REGIONAL_LANGUAGE,
  };
};

/** The plain-text fallbacks the document states, and the row's text. */
type DocumentText = {
  plain: string | undefined;
  verdict: string;
  justification: string;
};

const documentTextOf = (doc: CzRegionalFinaldoc | null): DocumentText => {
  const verdict = toOptionalValue(doc?.verdictText) ?? "";
  const justification = toOptionalValue(doc?.justificationText) ?? "";
  const parts = [verdict, justification].filter((part) => part.length > 0);
  return {
    plain: parts.length > 0 ? parts.join("\n\n") : undefined,
    verdict,
    justification,
  };
};

type ParseDocumentPayloadOptions = {
  doc: CzRegionalFinaldoc;
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string | undefined;
};

type ParsedDocument = {
  documentAst: DocumentAst | EmptyAst;
  fulltext: string | undefined;
};

/**
 * The document payload as an AST. A parse failure is not the decision's
 * failure: the payload is stored verbatim, so the text stays recoverable by
 * re-parsing what was kept, and the row falls back to the publisher's own
 * plain-text rendering meanwhile.
 */
const parseDocumentPayload = ({
  doc,
  caseNumber,
  ecli,
  court,
  decisionDate,
  decisionType,
  sourceUrl,
}: ParseDocumentPayloadOptions): ParsedDocument => {
  const text = documentTextOf(doc);
  try {
    const parsed = parseRegionalDecision({
      caseNumber,
      ecli,
      court,
      decisionDate,
      decisionType,
      sourceUrl,
      header: arrayOrEmpty(doc.header),
      verdict: arrayOrEmpty(doc.verdict),
      justification: arrayOrEmpty(doc.justification),
      information: arrayOrEmpty(doc.information),
      styles: arrayOrEmpty(doc.styles),
      verdictText: text.verdict,
      justificationText: text.justification,
    });
    return {
      documentAst: parsed.documentAst,
      fulltext: parsed.fulltext || text.plain,
    };
  } catch {
    return { documentAst: EMPTY_AST, fulltext: text.plain };
  }
};

export type CzRegionalBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** No docket and court to key on, or a record no court decided. */
  | { type: "unkeyable" }
  /**
   * The item links a document and nothing came back for it. The row is built
   * anyway and marked `isListingOnly`, because the listing observation is
   * durable and a crawl that dropped it would lose the identity too; the
   * reconciliation loop parks it instead, since a detail-less row there would
   * read as held and take the document out of every later pass.
   */
  | { type: "detail-unavailable"; decision: IngestionResult };

type AssembleCzRegionalOptions = {
  /** The listing row, which is the only surface stating several fields. */
  item: CzRegionalApiItem;
  /** The document payload, or null where none was read. */
  document: CzRegionalDocumentPayload | null;
  /** The chain payload, which only the chain pass supplies. */
  chain: CzRegionalChainPayload | null;
};

/**
 * Build one decision from the responses this source serves for it.
 *
 * Pure, and the one place the row's shape is decided: the crawl, the
 * reconciliation loop, the chain pass and a re-parse of a stored envelope all
 * come through here, so none of them can store a row the others would not.
 *
 * Every response is kept as a named part of the envelope. The listing row is
 * the only surface stating `autor`, `predmetRizeni`, `klicovaSlova` and
 * `zminenaUstanoveni` in words, so a crawl that parsed it and dropped it left
 * those unrecoverable for every row already stored.
 */
export const assembleCzRegionalDecision = ({
  item,
  document,
  chain,
}: AssembleCzRegionalOptions): CzRegionalBuildResult => {
  if (!item.jednaciCislo || !isCourtListing(item)) {
    return { type: "unkeyable" };
  }
  const parsedDocument = document?.parsed ?? null;
  if (!isCourtDocument(parsedDocument)) {
    return { type: "unkeyable" };
  }

  // This source publishes the docket with the sheet number appended.
  const { caseNumber, sheetNumber } = splitCaseReference(item.jednaciCislo);
  const publishedDocumentUrl = toOptionalValue(item.odkaz);
  const documentUrl = publishedDocumentUrl
    ? restrictCzRegionalFinaldocUrl(publishedDocumentUrl)
    : null;
  if (publishedDocumentUrl && documentUrl === null) {
    logger.warn("case_law.ingestion.outbound_url_rejected", {
      adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
      caseNumber,
    });
  }

  const docMetadata = parsedDocument?.metadata ?? undefined;
  const decisionTypeRaw = toOptionalValue(docMetadata?.type);
  const decisionType = mapDecisionType(decisionTypeRaw, caseNumber);
  // The document restates the decision's identifier and both its dates, which
  // is what makes that payload self-sufficient: a document reached without
  // its listing row would otherwise carry neither.
  const ecli = toOptionalValue(docMetadata?.ecli) ?? toOptionalValue(item.ecli);
  const decisionDate =
    toOptionalValue(docMetadata?.decisionAt) ??
    toOptionalValue(item.datumVydani);
  const publishedDate =
    toOptionalValue(docMetadata?.publishedAt) ??
    toOptionalValue(item.datumZverejneni);

  const solver = docMetadata?.solver ?? undefined;
  const judges =
    solver === undefined
      ? listingJudges(toOptionalValue(item.autor))
      : solverJudges(solver);

  const affectedDocs = docMetadata?.affectedDocs ?? undefined;
  // The typed relation (`CANCEL`, `CONFIRM`, …) and the affected court stay
  // on the metadata entry beside the dockets: `publisherCitedCases` is a list
  // of case numbers by contract, and dropping the relation would leave the
  // graph saying only that two decisions are connected.
  const publisherCitedCases = publisherCitedCasesOf(affectedDocs);

  const text = documentTextOf(parsedDocument);
  const parsed =
    parsedDocument === null
      ? null
      : parseDocumentPayload({
          doc: parsedDocument,
          caseNumber,
          ecli,
          court: item.soud ?? "",
          decisionDate,
          decisionType,
          sourceUrl: documentUrl?.toString(),
        });
  const fulltext = parsed?.fulltext ?? text.plain;

  const sourceRaw = encodeSourceRawEnvelope({
    [RAW_PART.LISTING]: JSON.stringify(item),
    ...(document === null ? {} : { [RAW_PART.DOCUMENT]: document.raw }),
    ...(chain === null ? {} : { [RAW_PART.CHAIN]: chain.raw }),
  });

  return {
    type: "built",
    decision: {
      caseNumber,
      sheetNumber,
      ecli,
      court: item.soud ?? "",
      country: ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_REGIONAL].country,
      language: CZ_REGIONAL_LANGUAGE,
      decisionDate,
      ...(decisionType === undefined ? {} : { decisionType }),
      ...(fulltext === undefined ? {} : { fulltext }),
      // The publisher linked a document and none is in hand: the listed
      // identity is durable, but the row carries the listing alone. Marking
      // it keeps the row out of every public surface, and out of what
      // `heldRequiresDetail` counts as held, so a later pass asks again. A
      // row the publisher links no document for is not marked: there is
      // nothing left to ask for.
      ...(document === null && documentUrl !== null
        ? { isListingOnly: true }
        : {}),
      ...(judges.length === 0 ? {} : { judges }),
      ...(publisherCitedCases.length === 0 ? {} : { publisherCitedCases }),
      sourceDocumentId:
        toOptionalValue(parsedDocument?.uuid) ??
        documentIdFromLink(publishedDocumentUrl),
      sourceUrl: documentUrl?.toString(),
      documentUrl: documentUrl?.toString(),
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      metadata: checkedDecisionMetadata({
        caseNumber,
        sheetNumber,
        // The reference exactly as the court publishes it, docket and sheet
        // together, so the split stays reversible from what we stored.
        publishedCaseNumber: item.jednaciCislo,
        ecli,
        court: item.soud,
        decisionDate,
        decisionType,
        author: toOptionalValue(item.autor),
        subjectOfProceeding: toOptionalValue(item.predmetRizeni),
        publishedDate,
        keywords: item.klicovaSlova,
        mentionedStatutes: item.zminenaUstanoveni,
        ...(decisionTypeRaw === undefined ? {} : { decisionTypeRaw }),
        ...(docMetadata === undefined
          ? {}
          : {
              caseNumberParts: docMetadata.caseNumber,
              courtCode: docMetadata.courtCode,
              solver,
              caseResultType: docMetadata.caseResultType,
              caseSubject: toOptionalValue(docMetadata.caseSubject),
              specialType: docMetadata.specialType,
              affectedDocs,
              regulations: docMetadata.regulations,
              flags: docMetadata.flags,
            }),
        ...(chain === null
          ? {}
          : {
              [CZ_REGIONAL_AFFECTING_DOCS_METADATA_KEY]: chain.entries,
            }),
      }),
      rawHash: hashContent(sourceRaw),
      parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_REGIONAL],
      documentAst: parsed?.documentAst ?? EMPTY_AST,
      sourceRaw,
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    },
  };
};

/**
 * Fetch the document for a listed item and assemble the decision.
 *
 * The document is fetched once per row and the outcome says whether it came
 * back, because the two callers need opposite things from that: the crawl
 * stores the listing observation either way, and the reconciliation loop
 * parks a row it could not read the document for.
 */
export const buildCzRegionalDecision = async (
  item: CzRegionalApiItem,
  signal?: AbortSignal,
): Promise<CzRegionalBuildResult> => {
  if (!item.jednaciCislo || !isCourtListing(item)) {
    return { type: "unkeyable" };
  }
  const publishedDocumentUrl = toOptionalValue(item.odkaz);
  // The publisher linked no document; the listing metadata is all there is,
  // and there is nothing left to ask for, so the row is complete as built.
  if (publishedDocumentUrl === undefined) {
    return assembleCzRegionalDecision({ item, document: null, chain: null });
  }
  const document = await fetchFinaldoc(
    publishedDocumentUrl,
    splitCaseReference(item.jednaciCislo).caseNumber,
    signal,
  );
  const built = assembleCzRegionalDecision({ item, document, chain: null });
  if (document !== null || built.type !== "built") {
    return built;
  }
  return { type: "detail-unavailable", decision: built.decision };
};

type CursorState = {
  date: string;
  page: number;
  /** Consecutive empty days (for gap-skipping). */
  emptyDays: number;
};

const parseCursor = (cursor: string): CursorState => {
  // Format: "YYYY-MM-DD:page" or "YYYY-MM-DD:page:emptyDays"
  const parts = cursor.split(":");
  if (parts.length >= 3) {
    // New format with emptyDays counter
    const date = parts.slice(0, -2).join(":");
    const page = Number.parseInt(parts.at(-2) ?? "0", 10);
    const emptyDays = Number.parseInt(parts.at(-1) ?? "0", 10);
    return {
      date: date || cursor,
      page: Number.isNaN(page) ? 0 : page,
      emptyDays: Number.isNaN(emptyDays) ? 0 : emptyDays,
    };
  }

  const colonIdx = cursor.lastIndexOf(":");
  if (colonIdx === -1) {
    return { date: cursor, page: 0, emptyDays: 0 };
  }

  const date = cursor.slice(0, colonIdx);
  const page = Number.parseInt(cursor.slice(colonIdx + 1), 10);

  return {
    date,
    page: Number.isNaN(page) ? 0 : page,
    emptyDays: 0,
  };
};

const makeCursor = (state: CursorState): string =>
  state.emptyDays > 0
    ? `${state.date}:${state.page}:${state.emptyDays}`
    : `${state.date}:${state.page}`;

/** Advance a YYYY-MM-DD string by N days (default 1). */
const advanceDate = (date: string, days: number = 1): string =>
  Temporal.PlainDate.from(date).add({ days }).toString();

/**
 * Calculate how many days to skip forward based on
 * consecutive empty days. Conservative thresholds to
 * avoid jumping over real data:
 *
 *   <30 empty:  1 day  (courts have weekends, holidays,
 *               recesses — 2+ weeks empty is normal)
 *   30-89:      7 days (a full month empty is unusual)
 *   90-179:    14 days (a full quarter empty)
 *   180+:      30 days (six months empty — likely pre-data era)
 *
 * These thresholds are intentionally conservative.
 * Court systems have long holiday recesses (2-4 weeks)
 * and some APIs backfill data months after the fact.
 */
const gapSkipDays = (consecutiveEmpty: number): number => {
  if (consecutiveEmpty >= 180) {
    return 30;
  }
  if (consecutiveEmpty >= 90) {
    return 14;
  }
  if (consecutiveEmpty >= 30) {
    return 7;
  }
  return 1;
};

const todayIso = (): string =>
  Temporal.Now.instant()
    .toString({ fractionalSecondDigits: 3 })
    .split("T")[0] ?? "1970-01-01";

const defaultDate = (): string =>
  addUtcDays(new Date(), -30).toISOString().split("T")[0] ?? "1970-01-01";

type FetchListPageOptions = {
  cursor: string | null;
  signal?: AbortSignal | undefined;
  state: CursorState;
};

const isRetryableListFailure = (error: AdapterFetchError): boolean =>
  isTimeoutError(error.cause) ||
  (error.cause instanceof FetchBoundaryError &&
    error.cause.status !== undefined &&
    error.cause.status >= 500);

const fetchListPage = async ({ cursor, signal, state }: FetchListPageOptions) =>
  await Result.tryPromise(
    {
      try: async ({ signal: attemptSignal }) => {
        if (attemptSignal?.aborted) {
          throw new DOMException("Cycle aborted", "AbortError");
        }

        const [year = 0, month = 1, day = 1] = state.date
          .split("-")
          .map(Number);
        const url = `${BASE_URL}/opendata/${year}/${month}/${day}?page=${state.page}`;
        const response = await fetchPublisher(url, {
          adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
          signal: attemptSignal,
          headers: {
            Accept: "application/json",
            "User-Agent": INGESTION_USER_AGENT,
          },
          timeoutMs: ADAPTER_TIMEOUT.REQUEST,
        });

        if (response.status >= 500) {
          throw new FetchBoundaryError({
            url,
            status: response.status,
            statusText: response.statusText,
            message: `CZ Regional API error: ${response.status}`,
          });
        }

        return response;
      },
      catch: (cause) => {
        if (cause instanceof FetchBoundaryError) {
          return new AdapterFetchError({
            message: cause.message,
            adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
            cursor,
            cause,
            ...(cause.status === undefined ? {} : { httpStatus: cause.status }),
          });
        }
        return adapterCatch(ADAPTER_KEYS.CZ_REGIONAL, cursor)(cause);
      },
    },
    {
      ...(signal ? { signal } : {}),
      retry: {
        times: LIST_FETCH_RETRIES,
        shouldRetry: isRetryableListFailure,
        delayMs: (failure, { attempt }) => {
          if (isTimeoutError(failure.cause)) {
            const delayMs = LIST_FETCH_RETRY_DELAY_MS * attempt;
            logger.warn("case_law.ingestion.page_timeout_retry", {
              adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
              "error.type": errorTag(failure),
              page: state.page,
              date: state.date,
              retry: attempt,
              maxRetries: LIST_FETCH_RETRIES,
              retryDelayMs: delayMs,
            });
            return delayMs;
          }

          if (
            !(failure.cause instanceof FetchBoundaryError) ||
            failure.cause.status === undefined
          ) {
            panic("Retry delay requested for a non-retryable list failure");
          }
          logger.warn("case_law.ingestion.page_server_error_retry", {
            adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
            "error.type": errorTag(failure),
            page: state.page,
            date: state.date,
            httpStatus: failure.cause.status,
            retry: attempt,
            maxRetries: LIST_FETCH_RETRIES,
          });
          return LIST_FETCH_RETRY_DELAY_MS;
        },
      },
    },
  );

type ListCzRegionalDayPageOptions = {
  /** Publication day, `YYYY-MM-DD`. */
  date: string;
  /** 0-indexed page within the day. */
  page: number;
  signal?: AbortSignal | undefined;
};

export type CzRegionalDayPage = {
  items: CzRegionalApiItem[];
  /** 0 for a day the publisher lists nothing for (the API answers 404). */
  totalPages: number;
};

/**
 * One page of the publisher's own day listing, with no finaldoc enrichment.
 *
 * The crawl reaches a day by walking its cursor forward and pays a finaldoc
 * fetch for every item on the page, which is the wrong shape for asking what
 * a day contains. This is the same request, the same retries and the same
 * payload validation as `fetchPage`, stopping at the listing.
 */
export const listCzRegionalDayPage = async ({
  date,
  page,
  signal,
}: ListCzRegionalDayPageOptions): Promise<CzRegionalDayPage> => {
  const state: CursorState = { date, page, emptyDays: 0 };
  const cursor = makeCursor(state);
  const responseResult = await fetchListPage({ cursor, signal, state });
  if (Result.isError(responseResult)) {
    throw responseResult.error;
  }
  const response = responseResult.value;

  // 404 is how this API says "nothing published that day".
  if (response.status === 404) {
    return { items: [], totalPages: 0 };
  }
  if (!response.ok) {
    throw new AdapterFetchError({
      message: `CZ Regional API error: ${response.status}`,
      adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
      cursor,
      httpStatus: response.status,
    });
  }

  const json = await response.json();
  if (!isCzRegionalPageResponse(json)) {
    throw new AdapterFetchError({
      message: "CZ Regional API returned an invalid payload",
      adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
      cursor,
    });
  }
  return {
    items: arrayOrEmpty(json.items),
    totalPages: json.totalPages ?? 1,
  };
};

/**
 * A reconciliation slice for this source is one UTC publication day, which is
 * exactly what the publisher's opendata endpoint is addressed by. `YYYY-MM-DD`
 * sorts lexicographically in chronological order, which is the ordering the
 * ledger relies on.
 */
const czRegionalDaySlices = createCalendarDaySliceWalk({
  firstSlice: CZ_REGIONAL_FEED_START,
  source: ADAPTER_KEYS.CZ_REGIONAL,
});

const listCzRegionalSlicePage = async ({
  slice,
  page,
  signal,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const { items, totalPages } = await listCzRegionalDayPage({
    date: slice,
    page,
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    items: items.map((item) => ({
      identity: czRegionalListingIdentity(item),
      payload: item,
    })),
    totalPages,
  };
};

/**
 * Rebuild a decision from a payload the loop stored verbatim. The payload is
 * revalidated rather than trusted: it may have been parked for days, and a
 * shape the adapter no longer recognises has to be reported as unbuildable
 * instead of parsed on faith.
 */
const buildCzRegionalFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> =>
  isCzRegionalApiItem(payload)
    ? await buildCzRegionalDecision(payload, signal)
    : { type: "unkeyable" };

// ── Source-field inventory ───────────────────────────────

/**
 * Every key this publisher states for one decision, addressed by the part
 * that states it.
 *
 * Qualified rather than bare because three parts share key names: `uuid`,
 * `caseNumber`, `courtCode` and `ecli` each appear on more than one of them
 * and mean a different thing on each — the document's `uuid` is this
 * decision, a chain entry's `uuid` is the decision that affected it.
 */
const SOURCE_FIELDS = [
  "listing.jednaciCislo",
  "listing.soud",
  "listing.autor",
  "listing.ecli",
  "listing.predmetRizeni",
  "listing.datumVydani",
  "listing.datumZverejneni",
  "listing.klicovaSlova",
  "listing.zminenaUstanoveni",
  "listing.odkaz",
  "document.uuid",
  "document.header",
  "document.verdict",
  "document.verdictText",
  "document.justification",
  "document.justificationText",
  "document.information",
  "document.styles",
  "document.metadata",
  "document.texts[].text",
  "document.texts[].anonStyle",
  "document.styleLocalId",
  "document.tableCellInfo",
  "document.styles[].localId",
  "document.styles[].alignment",
  "document.styles[].hasSpaceBefore",
  "document.styles[].hasSpaceAfter",
  "document.styles[].bold",
  "document.styles[].italic",
  "document.metadata.type",
  "document.metadata.ecli",
  "document.metadata.publishedAt",
  "document.metadata.decisionAt",
  "document.metadata.caseNumber",
  "document.metadata.solver",
  "document.metadata.courtCode",
  "document.metadata.caseResultType",
  "document.metadata.caseSubject",
  "document.metadata.specialType",
  "document.metadata.affectedDocs",
  "document.metadata.regulations",
  "document.metadata.flags",
  "chain[].uuid",
  "chain[].caseNumber",
  "chain[].courtCode",
  "chain[].affectedDate",
  "chain[].affectedTypes",
] as const;

/**
 * What becomes of each of them.
 *
 * The listing row and the document state several of the same facts twice, and
 * both copies are declared: a document reached without its listing row states
 * its own ECLI and dates, and a listing row reached without its document is
 * the only statement of the judge, the keywords and the statutes in words.
 */
const CZ_REGIONAL_SOURCE_FIELDS = {
  "listing.jednaciCislo": {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  "listing.soud": {
    disposition: "stored",
    target: { type: "result", key: "court" },
  },
  // The deciding judge as the listing pre-joins them, titles and all. The
  // document states the same person in parts, which is the better source, so
  // this is what the row's bench is built from only when no document was read.
  "listing.autor": {
    disposition: "stored",
    target: { type: "result", key: "judges" },
  },
  "listing.ecli": {
    disposition: "stored",
    target: { type: "result", key: "ecli" },
  },
  "listing.predmetRizeni": {
    disposition: "stored",
    target: { type: "metadata", key: "subjectOfProceeding" },
  },
  "listing.datumVydani": {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  "listing.datumZverejneni": {
    disposition: "stored",
    target: { type: "metadata", key: "publishedDate" },
  },
  "listing.klicovaSlova": {
    disposition: "stored",
    target: { type: "metadata", key: "keywords" },
  },
  "listing.zminenaUstanoveni": {
    disposition: "stored",
    target: { type: "metadata", key: "mentionedStatutes" },
  },
  // The link's last segment is the publisher's own document id, which is what
  // the row is keyed on; the link itself is the row's source address.
  "listing.odkaz": { disposition: "stored", target: { type: "identity" } },
  "document.uuid": { disposition: "stored", target: { type: "identity" } },
  "document.header": { disposition: "stored", target: { type: "document" } },
  "document.verdict": { disposition: "stored", target: { type: "document" } },
  "document.verdictText": {
    disposition: "stored",
    target: { type: "document" },
  },
  "document.justification": {
    disposition: "stored",
    target: { type: "document" },
  },
  "document.justificationText": {
    disposition: "stored",
    target: { type: "document" },
  },
  "document.information": {
    disposition: "stored",
    target: { type: "document" },
  },
  "document.styles": { disposition: "stored", target: { type: "document" } },
  "document.metadata": excludedSourceField(
    "the object holding the thirteen metadata keys below, each of which carries its own disposition",
  ),
  "document.texts[].text": {
    disposition: "stored",
    target: { type: "document" },
  },
  // `ANON` marks a span the publisher replaced with a description of what it
  // removed, which the document model carries as an anonymized text node.
  "document.texts[].anonStyle": {
    disposition: "stored",
    target: { type: "document" },
  },
  "document.styleLocalId": {
    disposition: "stored",
    target: { type: "document" },
  },
  "document.tableCellInfo": excludedSourceField(
    "a paragraph's placement inside a table; every payload sampled states it as null, so the shape a non-null value would take is unstated and nothing can be read from it",
  ),
  "document.styles[].localId": {
    disposition: "stored",
    target: { type: "document" },
  },
  "document.styles[].alignment": excludedSourceField(
    "how the paragraph was aligned on the printed page; the document model carries the text and its emphasis, not its layout",
  ),
  "document.styles[].hasSpaceBefore": excludedSourceField(
    "vertical spacing above the paragraph on the printed page, which the document model does not represent",
  ),
  "document.styles[].hasSpaceAfter": excludedSourceField(
    "vertical spacing below the paragraph on the printed page, which the document model does not represent",
  ),
  "document.styles[].bold": {
    disposition: "stored",
    target: { type: "document" },
  },
  "document.styles[].italic": {
    disposition: "stored",
    target: { type: "document" },
  },
  "document.metadata.type": {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  "document.metadata.ecli": {
    disposition: "stored",
    target: { type: "result", key: "ecli" },
  },
  "document.metadata.publishedAt": {
    disposition: "stored",
    target: { type: "metadata", key: "publishedDate" },
  },
  "document.metadata.decisionAt": {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  // The docket in parts, which is what makes the split of the printed
  // reference checkable instead of trusted; `registry` is the agenda code.
  "document.metadata.caseNumber": {
    disposition: "stored",
    target: { type: "metadata", key: "caseNumberParts" },
  },
  "document.metadata.solver": {
    disposition: "stored",
    target: { type: "result", key: "judges" },
  },
  // The stable court key the free-text court name only spells out.
  "document.metadata.courtCode": {
    disposition: "stored",
    target: { type: "metadata", key: "courtCode" },
  },
  "document.metadata.caseResultType": {
    disposition: "stored",
    target: { type: "metadata", key: "caseResultType" },
  },
  "document.metadata.caseSubject": {
    disposition: "stored",
    target: { type: "metadata", key: "caseSubject" },
  },
  "document.metadata.specialType": {
    disposition: "stored",
    target: { type: "metadata", key: "specialType" },
  },
  // The publisher's own outgoing relation graph. The dockets reach
  // `publisherCitedCases`; the relation kind and the affected court stay on
  // the metadata entry, which is the only place they fit.
  "document.metadata.affectedDocs": {
    disposition: "stored",
    target: { type: "result", key: "publisherCitedCases" },
  },
  "document.metadata.regulations": {
    disposition: "stored",
    target: { type: "metadata", key: "regulations" },
  },
  "document.metadata.flags": {
    disposition: "stored",
    target: { type: "metadata", key: "flags" },
  },
  // The incoming edges, whose five keys describe one entry and are stored as
  // that entry: the affecting document's id is the one thing the forward edge
  // never states, so the graph resolves without matching court and docket.
  "chain[].uuid": {
    disposition: "stored",
    target: { type: "metadata", key: "affectingDocs" },
  },
  "chain[].caseNumber": {
    disposition: "stored",
    target: { type: "metadata", key: "affectingDocs" },
  },
  "chain[].courtCode": {
    disposition: "stored",
    target: { type: "metadata", key: "affectingDocs" },
  },
  "chain[].affectedDate": {
    disposition: "stored",
    target: { type: "metadata", key: "affectingDocs" },
  },
  "chain[].affectedTypes": {
    disposition: "stored",
    target: { type: "metadata", key: "affectingDocs" },
  },
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;

const parsedPart = (parts: SourceRawParts, part: string): unknown =>
  parsedJson(parts[part] ?? "");

/** Keys of `value`, each prefixed, or nothing where it is not an object. */
const qualifiedKeys = (value: unknown, prefix: string): readonly string[] =>
  isRecord(value) ? Object.keys(value).map((key) => `${prefix}${key}`) : [];

/** The document's four paragraph sections, which share one paragraph shape. */
const DOCUMENT_PARAGRAPH_SECTIONS = [
  "header",
  "verdict",
  "justification",
  "information",
] as const;

/**
 * What the stored envelope states, read from every part of it.
 *
 * The page envelope's own keys (`pageSize`, `totalPages`, `totalElements`)
 * are deliberately not here: the part is the listing row, not the page it
 * arrived on, and those describe the walk rather than the decision.
 */
const unknownArray = (value: unknown): readonly unknown[] =>
  isUnknownArray(value) ? value : [];

const listCzRegionalSourceFields = (
  parts: SourceRawParts,
): readonly string[] => {
  const listing = parsedPart(parts, RAW_PART.LISTING);
  const document = parsedPart(parts, RAW_PART.DOCUMENT);
  const chain = parsedPart(parts, RAW_PART.CHAIN);
  const documentKey = (key: string): string => `document.${key}`;

  const stated = new Set<string>([
    ...qualifiedKeys(listing, "listing."),
    ...qualifiedKeys(document, "document."),
    ...qualifiedKeys(
      isRecord(document) ? document["metadata"] : undefined,
      "document.metadata.",
    ),
    ...unknownArray(
      isRecord(document) ? document["styles"] : undefined,
    ).flatMap((style) => qualifiedKeys(style, "document.styles[].")),
    ...unknownArray(chain).flatMap((entry) => qualifiedKeys(entry, "chain[].")),
  ]);

  // The paragraph shape is the same in all four sections, so its keys are
  // read once across them rather than once per section.
  for (const section of DOCUMENT_PARAGRAPH_SECTIONS) {
    const paragraphs = unknownArray(
      isRecord(document) ? document[section] : undefined,
    );
    for (const paragraph of paragraphs) {
      for (const key of Object.keys(isRecord(paragraph) ? paragraph : {})) {
        // `texts` is the span array; its own keys are listed below it.
        if (key !== "texts") {
          stated.add(documentKey(key));
        }
      }
      const spans = unknownArray(
        isRecord(paragraph) ? paragraph["texts"] : undefined,
      );
      for (const span of spans) {
        for (const key of qualifiedKeys(span, "document.texts[].")) {
          stated.add(key);
        }
      }
    }
  }

  return [...stated];
};

// ── Re-parsing a stored envelope ─────────────────────────

/**
 * Rebuild the decision this adapter would produce from a payload it stored,
 * without contacting the publisher.
 *
 * The envelope holds every response the crawl read, so a parser change is
 * replayable across the corpus. A row stored before this adapter wrote an
 * envelope holds the document payload alone and decodes to `null`: it is
 * reported rather than guessed at, because the listing row that would key it
 * was never kept.
 */
const reparseCzRegionalStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  if (stored.contentType !== SOURCE_RAW_ENVELOPE_CONTENT_TYPE) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: `stored under ${stored.contentType ?? "no content type"}`,
    };
  }
  const parts = decodeSourceRawEnvelope(new TextDecoder().decode(stored.raw));
  if (parts === null) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.RAW_FIDELITY_LOST,
      detail: "the stored payload is not an envelope",
    };
  }
  const item = parsedPart(parts, RAW_PART.LISTING);
  if (!isCzRegionalApiItem(item)) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: "the stored envelope holds no listing row",
    };
  }

  const documentRaw = parts[RAW_PART.DOCUMENT];
  const chainRaw = parts[RAW_PART.CHAIN];

  const built = assembleCzRegionalDecision({
    item,
    document:
      documentRaw === undefined ? null : readCzRegionalDocument(documentRaw),
    chain: chainRaw === undefined ? null : readCzRegionalChain(chainRaw),
  });
  if (built.type !== "built") {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: "the stored listing row states no court and docket",
    };
  }
  if (
    stored.sourceDocumentId !== null &&
    built.decision.sourceDocumentId !== stored.sourceDocumentId
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `the envelope names ${built.decision.sourceDocumentId ?? "no id"}, the row ${stored.sourceDocumentId}`,
    };
  }
  return { type: "parsed", result: built.decision };
};

/**
 * Every payload this service serves for one decision, and whether the row
 * keeps it.
 *
 * Three are kept and they are the whole per-decision surface: the day
 * listing's row, the document, and the chain of later documents affecting it.
 * Everything else the service exposes is a corpus-wide index, a completion
 * list, an export of a result set or an authenticated editing surface.
 */
const SOURCE_SURFACES = [
  "year-index",
  "month-index",
  "day-index",
  "listing",
  "document",
  "chain",
  "site-search",
  "typeahead",
  "allowed-registries",
  "bulk-export",
  "permalink-html",
  "editor-workflow",
] as const;

const CZ_REGIONAL_SOURCE_SURFACES = {
  surfaces: {
    "year-index": excludedSourceSurface(
      "a corpus-wide count index, useful as a coverage probe and stating no field of any decision",
    ),
    "month-index": excludedSourceSurface(
      "the same count index at a narrower granularity",
    ),
    "day-index": excludedSourceSurface(
      "the same count index per day; an absent day already answers what it would state",
    ),
    listing: storedSourceSurface(RAW_PART.LISTING),
    document: storedSourceSurface(RAW_PART.DOCUMENT),
    chain: storedSourceSurface(RAW_PART.CHAIN),
    "site-search": excludedSourceSurface(
      "a subset of the listing row, with match fragments that depend on the query that produced them",
    ),
    typeahead: excludedSourceSurface(
      "completions, not a payload about any one decision",
    ),
    "allowed-registries": excludedSourceSurface(
      "corpus vocabulary, not a payload about any one decision",
    ),
    "bulk-export": excludedSourceSurface(
      "an export of a result set, page-limited and scoped to the query rather than to a decision",
    ),
    "permalink-html": excludedSourceSurface(
      "a client-rendered shell that states no field",
    ),
    "editor-workflow": excludedSourceSurface(
      "authenticated surfaces for the service's own editors; they take submissions rather than publish decisions",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

export const czRegionalAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.CZ_REGIONAL,
  sourceSurfaces: CZ_REGIONAL_SOURCE_SURFACES,
  sourceFields: {
    status: "declared",
    fields: CZ_REGIONAL_SOURCE_FIELDS,
    listSourceFields: listCzRegionalSourceFields,
  },
  reparseStoredRaw: reparseCzRegionalStoredRaw,
  language: CZ_REGIONAL_LANGUAGE,
  minRequestIntervalMs: 200,
  // rozhodnuti.justice.cz returns 100 items per page; each
  // needs a finaldoc enrichment fetch. 30s default is too
  // tight for large pages with slow upstream responses.
  pageTimeoutMs: 100_000,

  /**
   * The year endpoint (`/opendata/{year}`) returns exact per-month
   * publication counts, so the source's total is the sum over the years it
   * has published — from October 2020, when the open-data feed began. A
   * failed year returns null rather than a partial sum, because an
   * undercount would read as a coverage gap that does not exist.
   */
  async getTotalCount(signal) {
    try {
      const FIRST_PUBLICATION_YEAR = 2020;
      const currentYear = Temporal.Now.plainDateISO().year;
      const years = Array.from(
        { length: currentYear - FIRST_PUBLICATION_YEAR + 1 },
        (_, i) => FIRST_PUBLICATION_YEAR + i,
      );
      const perYear = await Promise.all(
        years.map(async (year) => {
          const response = await fetchPublisher(
            `${BASE_URL}/opendata/${year}`,
            {
              adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
              signal,
              timeoutMs: ADAPTER_TIMEOUT.REQUEST,
            },
          );
          if (!response.ok) {
            return null;
          }
          const json: unknown = await response.json();
          if (!Array.isArray(json)) {
            return null;
          }
          let sum = 0;
          for (const month of json) {
            if (!isRecord(month) || typeof month["pocet"] !== "number") {
              return null;
            }
            sum += month["pocet"];
          }
          return sum;
        }),
      );
      let total = 0;
      for (const sum of perYear) {
        // One unreadable year makes the sum a floor rather than a total, and a
        // floor recorded as a total reads as coverage the corpus does not have.
        if (sum === null) {
          return sourceTotalProbeFailed(
            SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
          );
        }
        total += sum;
      }
      return sourceTotalRead(total);
    } catch (error) {
      return { type: "probe-failed", errorTag: errorTag(error) };
    }
  },

  /**
   * The publisher lists each day independently of the crawl cursor, so what a
   * day contains is answerable without re-crawling it: enumerate the day, key
   * each item the way the ingest would, and compare against what is held.
   */
  reconciliation: {
    firstSlice: CZ_REGIONAL_FEED_START,
    ...czRegionalDaySlices.walk,
    tipWindowDays: CZ_REGIONAL_TIP_WINDOW_DAYS,
    // A row whose linked document did not come back is marked
    // `isListingOnly`; unset, that stub would count as held and its document
    // would never be asked for again. A row the publisher links no document
    // for is not marked and stays held: there is nothing left to ask for, and
    // re-listing it on every pass would never let the day settle.
    heldRequiresDetail: true,
    listSlicePage: listCzRegionalSlicePage,
    buildDecision: buildCzRegionalFromPayload,
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const state: CursorState = cursor
          ? parseCursor(cursor)
          : { date: defaultDate(), page: 0, emptyDays: 0 };

        const fetchT0 = performance.now();

        const responseResult = await fetchListPage({
          cursor,
          signal,
          state,
        });
        if (Result.isError(responseResult)) {
          if (signal?.aborted) {
            throw new DOMException("Cycle aborted", "AbortError");
          }
          if (isTimeoutError(responseResult.error.cause)) {
            logger.warn("case_law.ingestion.page_timeout_exhausted", {
              adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
              page: state.page,
              date: state.date,
              retries: LIST_FETCH_RETRIES,
            });
          }
          throw responseResult.error;
        }
        const response = responseResult.value;

        if (!response.ok) {
          // 404 means no data for this date; skip forward
          if (response.status === 404) {
            const today = todayIso();
            const empty = state.emptyDays + 1;
            const skip = gapSkipDays(empty);
            const next = advanceDate(state.date, skip);

            return {
              decisions: [],
              nextCursor:
                next <= today
                  ? makeCursor({ date: next, page: 0, emptyDays: empty })
                  : makeCursor({ date: today, page: 0, emptyDays: 0 }),
            };
          }

          throw new AdapterFetchError({
            message: `CZ Regional API error: ${response.status}`,
            adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
            cursor,
            httpStatus: response.status,
          });
        }

        const json = await response.json();
        if (!isCzRegionalPageResponse(json)) {
          throw new AdapterFetchError({
            message: "CZ Regional API returned an invalid payload",
            adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
            cursor,
          });
        }
        const items = arrayOrEmpty(json.items);

        // One document fetch per listed row, in batches of
        // FINALDOC_CONCURRENCY, then the row and its document are assembled
        // together: the envelope has to hold both, so the listing row cannot
        // be turned into a decision before its document is in hand.
        const decisions: IngestionResult[] = [];
        for (let i = 0; i < items.length; i += FINALDOC_CONCURRENCY) {
          const built = await Promise.all(
            items.slice(i, i + FINALDOC_CONCURRENCY).map(async (item) => ({
              item,
              attempt: await Result.tryPromise({
                try: async () => await buildCzRegionalDecision(item, signal),
                catch: (cause) => cause,
              }),
            })),
          );
          for (const { item, attempt } of built) {
            if (Result.isError(attempt)) {
              // One row the adapter refuses must not fail the page and pin the
              // cursor on it; the reconciliation walk parks it instead.
              // Reported so a build failing on every row is not read as a
              // page with nothing on it.
              logger.warn("case_law.ingestion.item_build_failed", {
                adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
                ...(item.jednaciCislo ? { caseNumber: item.jednaciCislo } : {}),
                "error.type": errorTag(attempt.error),
              });
              continue;
            }
            const outcome = attempt.value;
            // A crawl keeps a listed row whose document did not answer: the
            // observation is durable and `isListingOnly` keeps the document
            // in what a later reconciliation asks for again.
            if (outcome.type !== "unkeyable") {
              decisions.push(outcome.decision);
            }
          }
        }

        const fetchMs = Math.round(performance.now() - fetchT0);
        logger.info("case_law.ingestion.page_completed", {
          adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
          page: state.page,
          date: state.date,
          decisions: decisions.length,
          items: items.length,
          totalMs: fetchMs,
        });

        const totalPages = json.totalPages ?? 1;

        // Use state.page (what we requested) instead of
        // json.pageNumber (what the API echoed back) to
        // avoid an infinite loop if the API ever returns
        // a stale or incorrect pageNumber.
        const currentPage = state.page;

        // Found results: reset empty counter
        const hasResults = decisions.length > 0;

        // More pages for this day: advance page (0-indexed)
        if (currentPage + 1 < totalPages) {
          return {
            decisions,
            nextCursor: makeCursor({
              date: state.date,
              page: currentPage + 1,
              emptyDays: 0,
            }),
          };
        }

        // Day exhausted: advance to next day
        const today = todayIso();
        const empty = hasResults ? 0 : state.emptyDays + 1;
        const skip = hasResults ? 1 : gapSkipDays(empty);
        const next = advanceDate(state.date, skip);

        return {
          decisions,
          nextCursor:
            next <= today
              ? makeCursor({ date: next, page: 0, emptyDays: empty })
              : makeCursor({ date: today, page: 0, emptyDays: 0 }),
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_REGIONAL, cursor),
    });
  },
});
