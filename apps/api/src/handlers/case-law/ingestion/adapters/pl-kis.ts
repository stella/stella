/**
 * Polish tax interpretations and rulings (EUREKA) adapter.
 *
 * The Ministry of Finance publishes the tax administration's interpretations,
 * explanations and binding rate and excise rulings at eureka.mf.gov.pl, behind
 * the JSON API its own search page reads. Four properties of that API decide
 * the shape below.
 *
 * **The search is a POST to a path ending in a slash.** Without the slash, or
 * without a JSON body naming `filter` and `columns`, it fails; a dictionary
 * filter takes an array of numeric ids and nothing else.
 *
 * **The search serves at most 10 000 rows of one query.** A page reaching past
 * that offset fails, so every walk runs inside a window the search serves
 * whole: one issue month for the crawl, one issue month of one category for
 * the reconciliation ledger.
 *
 * **Document ids grow with publication.** Sorted by `ID_INFORMACJI` the
 * listing is publication order, whatever the issue date, which is what the
 * tip's frontier is read off. Inside a month window, ascending ids append at
 * the end, so an offset the sweep has passed does not shift under it.
 *
 * **A listing row states labels, a detail states ids.** Dictionary fields
 * (authority, status, keywords, provisions) come back as their labels in the
 * listing and as dictionary ids in the detail, so both responses are kept.
 *
 * Cursor, in two phases:
 *
 *   undated|<boundary id>|<page>
 *   sweep|<boundary id>|<issue month>|<page>
 *   tip|head|<frontier id>
 *   tip|catch-up|<frontier id>|<pending id>|<page>
 *
 * The sweep pages each issue month oldest first. `<boundary id>` is the newest
 * document id when the sweep started; the tip takes over from exactly there.
 * The tip reads newest first and stops at the first id the frontier covers,
 * so a quiet cycle costs one request. A document published into a month the
 * sweep has passed is the reconciliation ledger's, whose slices are an issue
 * month of one category, so the ledger is also the census per year and per
 * category.
 *
 * A record that states no issue date is in no month. The listing sorted by
 * issue date serves those first, so the crawl reads that head before the
 * months (`undated|<boundary id>|<page>`) and the ledger holds it as a slice
 * of its own, ahead of the first month.
 */

import { Result, panic } from "better-result";

import { readCappedBytes } from "@stll/skills/streaming";
import { parsePlainDate, Temporal } from "@stll/time";

import { ADAPTER_KEYS, PARSER_VERSIONS } from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  decodeSourceRawEnvelopeObjects,
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  STORED_RAW_REPARSE_REJECTION,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
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
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  parsePlKisDocumentHtml,
  parsePlKisDocumentPdf,
} from "@/api/handlers/case-law/ingestion/parsers/pl-kis";
import type {
  ParsePlKisDocumentInput,
  ParsePlKisDocumentOutput,
} from "@/api/handlers/case-law/ingestion/parsers/pl-kis";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  absentTextField,
  checkedDecisionMetadata,
  sourceTextField,
} from "@/api/lib/case-law/decision-text";
import type { TextField } from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { logger } from "@/api/lib/observability/logger";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { isRecord } from "@/api/lib/type-guards";

// ── Publisher boundary ───────────────────────────────────

const ORIGIN = "https://eureka.mf.gov.pl";
const API_ROOT = `${ORIGIN}/api/public/v1`;

/** The only origin this adapter reaches; every URL is built from an id (rule 21). */
const PL_KIS_HOST_POLICY = {
  type: "exact-origin",
  origins: [ORIGIN],
} as const;

const LANGUAGE = "pl";

const MIN_REQUEST_INTERVAL_MS = publisherRequestIntervalMs(ADAPTER_KEYS.PL_KIS);

const DATE_RANGE = ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_KIS].dateRange;
const FIRST_MONTH = DATE_RANGE.fromInclusive.slice(0, 7);

/** The offset the search refuses to reach; a window this large is a failure. */
export const PL_KIS_RESULT_WINDOW = 10_000;

/** Rows the crawl lists at a time; each costs a detail request behind the gate. */
const CRAWL_PAGE_SIZE = 10;

/** Rows a reconciliation page lists; listing only, no detail. */
const RECONCILIATION_PAGE_SIZE = 100;

/** Empty issue months one `fetchPage` may step over before banking progress. */
const MAX_EMPTY_WINDOW_SKIPS = 12;

/**
 * A request the service leaves unanswered is abandoned after this long and
 * asked again. An answered request takes about a second; an unanswered one
 * stays open for minutes, and a large share of requests go unanswered, so the
 * wait is short and the retries many.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_RETRIES = 8;

const SORT = {
  ID_ASC: ["ID_INFORMACJI,asc"],
  ID_DESC: ["ID_INFORMACJI,desc"],
  // A record with no issue date sorts ahead of every dated one.
  UNDATED_FIRST: ["DT_WYD,asc", "ID_INFORMACJI,asc"],
} as const;

type PlKisSort = readonly string[];

/** Wider than any issue date the service holds: its count is the dated count. */
const EVERY_ISSUE_DATE = { from: "1900-01-01", to: "2100-12-31" } as const;

/**
 * Every column the search can state for a row. Requested whole, so the stored
 * row carries every label the service has for the document.
 */
export const PL_KIS_LISTING_COLUMNS = [
  "ID_INFORMACJI",
  "KATEGORIA_INFORMACJI",
  "SYG",
  "DT_WYD",
  "TEZA",
  "STATUS_INFORMACJI",
  "DATA_PUBLIKACJI",
  "AUTOR",
  "SLOWA_KLUCZOWE",
  "PRZEPISY",
  "ZAGADNIENIA",
  "INFORMACJA_ZMIENIANA",
  "MIEJ_PUB",
  "INN_ZROD",
  "RODZAJ_DECYZJI",
  "DAT_WAZ_OD",
  "DAT_WAZ_DO",
  "STAN_PRAW",
  "NOMENKLATURA_SCALONA",
  "KLASYFIKACJA_PKWIU",
  "KLASYFIKACJA_PKOB",
  "RODZAJ_WYROBU_AKCYZOWEGO",
  "DATA_REJESTRACJI",
  "KOMENTARZE_BIP",
  "KOM_BIP_OPIS",
] as const;

// ── Categories ───────────────────────────────────────────

type IncludedCategory = {
  readonly disposition: "included";
  /** The service's dictionary id, which is what its filter takes. */
  readonly id: number;
  /** ASCII, ordered: a reconciliation slice ends in it and slices sort. */
  readonly slug: string;
  /** The category's own name, lowercased: the stored decision type. */
  readonly decisionType: string;
  /**
   * The category's name as the service's dictionary and listing spell it,
   * where it is longer than the decision type stored.
   */
  readonly label?: string;
  /** What a document of this category does to the one it names, if any. */
  readonly relation?: "amends" | "revokes";
};

type ExcludedCategory = {
  readonly disposition: "excluded";
  readonly id: number;
  readonly reason: string;
};

/**
 * Every category the service's dictionary lists, and whether it is ingested.
 *
 * Keyed by the dictionary's own code, so a category the service adds is a
 * code this map does not hold, and `plKisCategoryById` answers nothing for it
 * rather than a guess.
 */
export const PL_KIS_CATEGORIES = {
  INTERPRETACJA_INDYWIDUALNA: {
    disposition: "included",
    id: 1,
    slug: "01-ind",
    decisionType: "interpretacja indywidualna",
  },
  ZMIANA_INTERPRETACJI_INDYWIDUALNEJ: {
    disposition: "included",
    id: 2,
    slug: "02-ind-zm",
    decisionType: "zmiana interpretacji indywidualnej",
    relation: "amends",
  },
  INTERPRETACJA_OGOLNA: {
    disposition: "included",
    id: 3,
    slug: "03-ogol",
    decisionType: "interpretacja ogólna",
  },
  ZMIANA_INTERPRETACJI_OGOLNEJ: {
    disposition: "included",
    id: 4,
    slug: "04-ogol-zm",
    decisionType: "zmiana interpretacji ogólnej",
    relation: "amends",
  },
  OBJASNIENIA_PODATKOWE: {
    disposition: "included",
    id: 11,
    slug: "05-objas",
    decisionType: "objaśnienia podatkowe",
  },
  WIAZACA_INFORMACJA_STAWKOWA: {
    disposition: "included",
    id: 18,
    slug: "06-wis",
    decisionType: "wiążąca informacja stawkowa",
  },
  ZMIANA_WIAZACEJ_INFORMACJI_STAWKOWEJ: {
    disposition: "included",
    id: 19,
    slug: "07-wis-zm",
    decisionType: "zmiana wiążącej informacji stawkowej",
    relation: "amends",
  },
  ODMOWA_WYDANIA_WIS: {
    disposition: "included",
    id: 62_913,
    slug: "08-wis-odm",
    decisionType: "odmowa wydania wiążącej informacji stawkowej",
  },
  UCHYLENIE_WIS: {
    disposition: "included",
    id: 62_915,
    slug: "09-wis-uch",
    decisionType: "uchylenie wiążącej informacji stawkowej",
    relation: "revokes",
  },
  UCHYLENIE_ODMOWY_WIS: {
    disposition: "included",
    id: 63_540,
    slug: "10-wis-uch-odm",
    decisionType: "uchylenie odmowy wydania wiążącej informacji stawkowej",
    relation: "revokes",
  },
  WIAZACA_INFORMACJA_AKCYZOWA: {
    disposition: "included",
    id: 16,
    slug: "11-wia",
    decisionType: "wiążąca informacja akcyzowa",
  },
  ZMIANA_WIAZACEJ_INFORMACJI_AKCYZOWEJ: {
    disposition: "included",
    id: 17,
    slug: "12-wia-zm",
    decisionType: "zmiana wiążącej informacji akcyzowej",
    relation: "amends",
  },
  ODMOWA_WYDANIA_WIA: {
    disposition: "included",
    id: 62_914,
    slug: "13-wia-odm",
    decisionType: "odmowa wydania wiążącej informacji akcyzowej",
  },
  UCHYLENIE_WIA: {
    disposition: "included",
    id: 62_916,
    slug: "14-wia-uch",
    decisionType: "uchylenie wiążącej informacji akcyzowej",
    relation: "revokes",
  },
  INFORMACJA_O_WYDANIU_OPINII_ZABEZPIECZAJACEJ: {
    disposition: "included",
    id: 14,
    slug: "15-opz",
    decisionType: "informacja o wydaniu opinii zabezpieczającej",
  },
  INFORMACJA_O_ODMOWIE_WYDANIA_OPINII: {
    disposition: "included",
    id: 15,
    slug: "16-opz-odm",
    decisionType: "informacja o odmowie wydania opinii zabezpieczającej",
  },
  OPINIA_OPODATKOWANIE_WYROWNAWCZE: {
    disposition: "included",
    id: 67_890,
    slug: "17-opw",
    decisionType: "opinia w sprawie opodatkowania wyrównawczego",
  },
  ODMOWA_OPINII_OPODATKOWANIE_WYROWNAWCZE: {
    disposition: "included",
    id: 74_593,
    slug: "18-opw-odm",
    decisionType:
      "postanowienie o odmowie wydania opinii w sprawie opodatkowania wyrównawczego",
    label:
      "Postanowienie o odmowie wydania opinii w sprawie opodatkowania wyrównawczego na podstawie art. 14u § 5 Ordynacji podatkowej",
  },
  POSTANOWIENIE_ROZSTRZYGAJACE_SPOR_O_WLASCIWOSC: {
    disposition: "included",
    id: 23,
    slug: "19-spor",
    decisionType: "postanowienie rozstrzygające spór o właściwość",
  },
  BROSZURA_INFORMACYJNA: {
    disposition: "excluded",
    id: 5,
    reason: "a leaflet for taxpayers, not a decision in any matter",
  },
  INFORMACJA_MINISTERSTWA_FINANSOW_DLA_DZIENNIKARZY: {
    disposition: "excluded",
    id: 10,
    reason: "an answer to a journalist, not a decision in any matter",
  },
  INFORMACJE_PRASOWE_KIS: {
    disposition: "excluded",
    id: 64_697,
    reason: "a press release",
  },
  NEWSLETTER: {
    disposition: "excluded",
    id: 34,
    reason: "a newsletter, with no issue date",
  },
  ODPOWIEDZ_DLA_SENATOROW: {
    disposition: "excluded",
    id: 7,
    reason: "a parliamentary answer, with no issue date",
  },
  ODPOWIEDZ_NA_ZAPYTANIE_POSELSKIE: {
    disposition: "excluded",
    id: 6,
    reason: "a parliamentary answer, with no issue date",
  },
  ORZECZENIA_SADOW: {
    disposition: "excluded",
    id: 26,
    reason:
      "copies of court judgments, which the court sources publish themselves",
  },
  PIGULKA_WIEDZY_UZGODNIENIE: {
    disposition: "excluded",
    id: 21,
    reason: "the service's internal guidance note, not addressed to anyone",
  },
  PISMO_MINISTERSTWA_FINANSOW: {
    disposition: "excluded",
    id: 9,
    reason: "correspondence of the ministry, not a decision in any matter",
  },
  WYTYCZNE_MINISTERSTWA_FINANSOW: {
    disposition: "excluded",
    id: 8,
    reason: "guidance for businesses, whose signature field holds a title",
  },
} as const satisfies Record<string, IncludedCategory | ExcludedCategory>;

const CATEGORY_LIST: readonly (IncludedCategory | ExcludedCategory)[] =
  Object.values(PL_KIS_CATEGORIES);

export const PL_KIS_INCLUDED_CATEGORIES: readonly IncludedCategory[] =
  CATEGORY_LIST.filter(
    (category): category is IncludedCategory =>
      category.disposition === "included",
  ).toSorted((left, right) => (left.slug < right.slug ? -1 : 1));

const INCLUDED_IDS = PL_KIS_INCLUDED_CATEGORIES.map(({ id }) => id);

export const plKisCategoryById = (
  id: number,
): IncludedCategory | ExcludedCategory | undefined =>
  CATEGORY_LIST.find((category) => category.id === id);

/**
 * The category a listing states by label, for a row whose detail never
 * arrived. The label is the category's name as the service capitalises it.
 */
export const plKisCategoryLabel = (category: IncludedCategory): string =>
  (category.label ?? category.decisionType).toLocaleLowerCase("pl-PL");

const categoryByLabel = (label: string): IncludedCategory | undefined =>
  PL_KIS_INCLUDED_CATEGORIES.find(
    (category) =>
      plKisCategoryLabel(category) === label.toLocaleLowerCase("pl-PL"),
  );

// ── Statuses ─────────────────────────────────────────────

/** The service's status dictionary, read into what a reader acts on. */
export const PL_KIS_STATUSES = {
  27: "current",
  28: "draft",
  29: "superseded",
  30: "outdated",
  33: "deleted",
} as const satisfies Record<number, string>;

type PlKisStatus =
  | (typeof PL_KIS_STATUSES)[keyof typeof PL_KIS_STATUSES]
  | "unknown";

const statusOf = (id: string | undefined): PlKisStatus => {
  const entry = Object.entries(PL_KIS_STATUSES).find(
    ([key]) => key === id,
  )?.[1];
  return entry ?? "unknown";
};

// ── Requests ─────────────────────────────────────────────

export type PlKisListingQuery = {
  categories: readonly number[];
  /** Inclusive issue-date bounds, `YYYY-MM-DD`; absent means unbounded. */
  issuedFrom?: string | undefined;
  issuedTo?: string | undefined;
  sort: PlKisSort;
  page: number;
  size: number;
};

/**
 * The search address. The slash before the query is load-bearing: the service
 * answers the same path without it with a failure.
 */
export const plKisListingUrl = ({
  page,
  size,
  sort,
}: Pick<PlKisListingQuery, "page" | "size" | "sort">): string =>
  `${API_ROOT}/wyszukiwarka/informacje/?${new URLSearchParams([
    ["size", String(size)],
    ["page", String(page)],
    ...sort.map((key): [string, string] => ["sort", key]),
  ]).toString()}`;

/**
 * The search body. `filter` and `columns` are both required; a dictionary
 * filter is an array of numeric ids, never a single value.
 */
export const plKisListingBody = ({
  categories,
  issuedFrom,
  issuedTo,
}: Pick<PlKisListingQuery, "categories" | "issuedFrom" | "issuedTo">): string =>
  JSON.stringify({
    filter: {
      KATEGORIA_INFORMACJI: categories.map(Number),
      ...(issuedFrom === undefined ? {} : { DT_WYD_start: issuedFrom }),
      ...(issuedTo === undefined ? {} : { DT_WYD_end: issuedTo }),
    },
    columns: PL_KIS_LISTING_COLUMNS,
    searchInFullPhrase: false,
    searchInContent: false,
    searchInSynonyms: false,
    warunkiDodatkowe: [],
  });

const detailUrl = (id: string): string => `${API_ROOT}/informacje/${id}`;
/** The format is upper-case: `pdf` leaves the request unanswered. */
const pdfUrl = (id: string): string =>
  `${API_ROOT}/informacje/${id}/eksport/PDF`;
/** The service's own page for a document, which a reader is sent to. */
export const plKisWebUrl = (id: string): string =>
  `${ORIGIN}/informacje/podglad/${id}`;

/** The most one response may hold; a detail with its HTML is well under it. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

type EurekaResponse = {
  status: number;
  ok: boolean;
  /** The body, or `null` when the request failed or the body overran. */
  bytes: Uint8Array | null;
  url: string;
};

/**
 * One request to the service, restricted to its origin, with its body read
 * under a ceiling.
 */
const fetchEureka = async (
  rawUrl: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
  signal?: AbortSignal,
): Promise<EurekaResponse> => {
  const target = restrictOutboundUrl({
    hostPolicy: PL_KIS_HOST_POLICY,
    rawUrl,
  });
  if (target === null) {
    return panic("EUREKA request escaped the publisher origin");
  }
  const response = await fetchWithRetry(
    target.toString(),
    {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body ?? null,
      redirect: "error",
    },
    {
      adapterKey: ADAPTER_KEYS.PL_KIS,
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxRetries: REQUEST_RETRIES,
    },
  );
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    return {
      status: response.status,
      ok: false,
      bytes: null,
      url: target.toString(),
    };
  }
  return {
    status: response.status,
    ok: true,
    bytes: await readCappedBytes(response.body, MAX_RESPONSE_BYTES),
    url: target.toString(),
  };
};

const requestError = (
  cursor: string | null,
  message: string,
  httpStatus?: number,
): AdapterFetchError =>
  new AdapterFetchError({
    message: `eureka.mf.gov.pl: ${message}`,
    adapterKey: ADAPTER_KEYS.PL_KIS,
    cursor,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

export type PlKisListing = {
  rows: Record<string, unknown>[];
  totalHits: number;
};

/**
 * The search envelope, read strictly: a body without a numeric `totalHits`
 * and a `results` array is not an empty result (rule 20).
 */
export const readPlKisListing = (value: unknown): PlKisListing | null => {
  if (!isRecord(value)) {
    return null;
  }
  const { results, totalHits } = value;
  if (
    typeof totalHits !== "number" ||
    !Number.isSafeInteger(totalHits) ||
    totalHits < 0 ||
    !Array.isArray(results)
  ) {
    return null;
  }
  return { rows: results.filter(isRecord), totalHits };
};

/**
 * Whether a page listed fewer rows than its own count promises for it: a
 * failure, never an end (rule 14), because the rows it withheld are the ones
 * no later page would list.
 */
export const plKisPageIsShort = (
  listing: PlKisListing,
  page: number,
  size: number,
): boolean =>
  listing.rows.length <
  Math.min(size, Math.max(0, listing.totalHits - page * size));

type ListingResponse = PlKisListing & { url: string };

const search = async (
  query: PlKisListingQuery,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<ListingResponse, AdapterFetchError>> => {
  const response = await fetchEureka(
    plKisListingUrl(query),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: plKisListingBody(query),
    },
    signal,
  );
  if (!response.ok || response.bytes === null) {
    return Result.err(
      requestError(
        cursor,
        `search answered ${response.status}`,
        response.status,
      ),
    );
  }
  const text = new TextDecoder().decode(response.bytes);
  const read = readPlKisListing(
    Result.try({
      try: (): unknown => JSON.parse(text),
      catch: () => null,
    }).unwrapOr(null),
  );
  return read === null
    ? Result.err(requestError(cursor, "search answered no readable result"))
    : Result.ok({ ...read, url: response.url });
};

// ── Listing rows and details ─────────────────────────────

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** A listing column as labels: the search writes one as a string or a list. */
const labelsOf = (value: unknown): string[] => {
  if (typeof value === "string") {
    return value.trim() === "" ? [] : [value];
  }
  return Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item === "string" && item.trim() !== "" ? [item] : [],
      )
    : [];
};

/** A detail field as dictionary ids: strings in one field, numbers in another. */
const idsOf = (value: unknown): string[] => {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    if (typeof item === "number" && Number.isSafeInteger(item)) {
      return [String(item)];
    }
    return typeof item === "string" && item.trim() !== "" ? [item] : [];
  });
};

const DOCUMENT_ID_PATTERN = /^\d{1,12}$/u;

/** The id a row is stored under, exactly as the service states it. */
export const plKisDocumentIdOf = (
  row: Record<string, unknown>,
): string | undefined => {
  const value = row["ID_INFORMACJI"];
  const id =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : optionalString(value);
  return id !== undefined && DOCUMENT_ID_PATTERN.test(id) ? id : undefined;
};

const QUARANTINE_ID_PREFIX = "eureka-quarantine:";

/**
 * The content-addressed identity of a counted row that states no usable id.
 *
 * Built only from fields a row keeps when its id recovers, so the observation
 * that learns the id adopts the audited row rather than adding a second one.
 */
export const plKisQuarantineId = (row: Record<string, unknown>): string =>
  `${QUARANTINE_ID_PREFIX}${hashContent(
    JSON.stringify({
      signature: row["SYG"] ?? null,
      issued: row["DT_WYD"] ?? null,
      category: row["KATEGORIA_INFORMACJI"] ?? null,
      authority: row["AUTOR"] ?? null,
      thesis: row["TEZA"] ?? null,
    }),
  )}`;

/** The identity a listed row is stored under: its id, or its quarantine key. */
export const plKisStoredIdOf = (row: Record<string, unknown>): string =>
  plKisDocumentIdOf(row) ?? plKisQuarantineId(row);

export const plKisListingIdentity = (
  row: Record<string, unknown>,
): ListingIdentity => ({
  type: "document",
  sourceDocumentId: plKisStoredIdOf(row),
});

/** One field of a detail, as the service types it. */
type PlKisDetailField = { dataType: string | undefined; value: unknown };

export type PlKisDetail = {
  id: string;
  top: Record<string, unknown>;
  fields: ReadonlyMap<string, PlKisDetailField>;
};

/** The detail envelope, or `null` for a body that is not one. */
export const readPlKisDetail = (value: unknown): PlKisDetail | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id =
    typeof value["id"] === "number" && Number.isSafeInteger(value["id"])
      ? String(value["id"])
      : optionalString(value["id"]);
  const documentPart = value["dokument"];
  if (
    id === undefined ||
    !DOCUMENT_ID_PATTERN.test(id) ||
    !isRecord(documentPart) ||
    !Array.isArray(documentPart["fields"])
  ) {
    return null;
  }
  const fields = new Map<string, PlKisDetailField>();
  for (const field of documentPart["fields"]) {
    if (!isRecord(field)) {
      continue;
    }
    const key = optionalString(field["key"]);
    if (key !== undefined) {
      fields.set(key, {
        dataType: optionalString(field["dataType"]),
        value: field["value"],
      });
    }
  }
  const { dokument: _document, ...top } = value;
  return { id, top, fields };
};

const detailString = (
  detail: PlKisDetail | undefined,
  key: string,
): string | undefined => optionalString(detail?.fields.get(key)?.value);

const detailIds = (detail: PlKisDetail | undefined, key: string): string[] =>
  detail === undefined ? [] : idsOf(detail.fields.get(key)?.value);

/**
 * A date the service states, as the calendar day in Poland.
 *
 * The listing writes a bare `YYYY-MM-DD`; the detail writes the same day as
 * an instant, which falls on the previous UTC day for anything issued after
 * midnight in Warsaw.
 */
export const plKisDay = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return parsePlainDate(value)?.toString();
  }
  return Result.try({
    try: () =>
      Temporal.Instant.from(value)
        .toZonedDateTimeISO("Europe/Warsaw")
        .toPlainDate()
        .toString(),
    catch: () => undefined,
  }).unwrapOr(undefined);
};

/**
 * A provision the service tagged, read into its parts:
 * `[VAT][WIS] Ustawa o podatku od towarów i usług-Dział IX-Rozdział 1-art. 86-ust. 2a`.
 */
export type PlKisProvision = {
  /** The bracketed tax tags the service files the provision under. */
  taxTags: string[];
  act: string;
  /** Division, chapter, article, paragraph, point, as printed. */
  units: string[];
  raw: string;
};

const UNIT_HEAD =
  /^(?:Dział|Rozdział|Oddział|Tytuł|art\.|ust\.|pkt|lit\.|tiret|§|zał\.|Załącznik|poz\.)/iu;

export const parsePlKisProvision = (raw: string): PlKisProvision => {
  // `[VAT][WIS] Ustawa…`: the tags are everything before the last bracket.
  const tagEnd = raw.lastIndexOf("]") + 1;
  const tags = raw
    .slice(0, tagEnd)
    .split("]")
    .map((part) => part.replaceAll("[", "").trim())
    .filter((tag) => tag.length > 0);
  const body = raw.slice(tagEnd).trim();
  const [head = "", ...rest] = body.split("-");
  // An act's own name may hold a hyphen; a part that does not open a unit is
  // the act's name continuing.
  let act = head.trim();
  const units: string[] = [];
  for (const part of rest) {
    const trimmed = part.trim();
    if (units.length === 0 && !UNIT_HEAD.test(trimmed)) {
      act = `${act}-${trimmed}`;
      continue;
    }
    if (trimmed.length > 0) {
      units.push(trimmed);
    }
  }
  return { taxTags: tags, act, units, raw };
};

/** An issue the service files the document under, as its path. */
const issuePathOf = (label: string): string[] =>
  label
    .split("-")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

// ── Source-field inventory ───────────────────────────────

/** Where the detail's own top-level keys are named in the inventory. */
const TOP_PREFIX = "informacja/";

/** Every field the listing and the detail state, by the service's own key. */
const SOURCE_FIELDS = [
  "ID_INFORMACJI",
  "KATEGORIA_INFORMACJI",
  "STATUS_INFORMACJI",
  "DATA_PUBLIKACJI",
  "TEZA",
  "AUTOR",
  "DT_WYD",
  "SYG",
  "SLOWA_KLUCZOWE",
  "PRZEPISY",
  "ZAGADNIENIA",
  "ZALACZNIKI",
  "TRESC_INTERESARIUSZ",
  "MIEJ_PUB",
  "INN_ZROD",
  "INFORMACJA_ZMIENIANA",
  "RODZAJ_DECYZJI",
  "DAT_WAZ_OD",
  "DAT_WAZ_DO",
  "STAN_PRAW",
  "NOMENKLATURA_SCALONA",
  "KLASYFIKACJA_PKWIU",
  "KLASYFIKACJA_PKOB",
  "RODZAJ_WYROBU_AKCYZOWEGO",
  "DATA_REJESTRACJI",
  "KOMENTARZE_BIP",
  "KOM_BIP_OPIS",
  "POZIOM_DOSTEPU_WYBRANEJ_TRESCI",
  "WYNIK_ANALIZY",
  `${TOP_PREFIX}id`,
  `${TOP_PREFIX}versionId`,
  `${TOP_PREFIX}nazwa`,
  `${TOP_PREFIX}szablonId`,
  `${TOP_PREFIX}wersjaSzablonuId`,
  `${TOP_PREFIX}informacjaTytulDto`,
] as const;

type PlKisSourceField = (typeof SOURCE_FIELDS)[number];

const metadataField = (key: string): SourceFieldDisposition => ({
  disposition: "stored",
  target: { type: "metadata", key },
});

const PL_KIS_SOURCE_FIELDS = {
  ID_INFORMACJI: { disposition: "stored", target: { type: "identity" } },
  KATEGORIA_INFORMACJI: {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  STATUS_INFORMACJI: metadataField("status"),
  DATA_PUBLIKACJI: metadataField("publishedAt"),
  TEZA: {
    disposition: "stored",
    target: { type: "textField", key: "headnote" },
  },
  AUTOR: { disposition: "stored", target: { type: "result", key: "court" } },
  DT_WYD: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  SYG: { disposition: "stored", target: { type: "result", key: "caseNumber" } },
  SLOWA_KLUCZOWE: metadataField("keywords"),
  PRZEPISY: metadataField("provisions"),
  ZAGADNIENIA: metadataField("issues"),
  ZALACZNIKI: metadataField("attachments"),
  TRESC_INTERESARIUSZ: { disposition: "stored", target: { type: "document" } },
  MIEJ_PUB: metadataField("officialPublication"),
  INN_ZROD: metadataField("otherSourceUrl"),
  INFORMACJA_ZMIENIANA: metadataField("relatedDocuments"),
  RODZAJ_DECYZJI: metadataField("decisionKind"),
  DAT_WAZ_OD: metadataField("validFrom"),
  DAT_WAZ_DO: metadataField("validUntil"),
  STAN_PRAW: metadataField("legalStateAsOf"),
  NOMENKLATURA_SCALONA: metadataField("combinedNomenclature"),
  KLASYFIKACJA_PKWIU: metadataField("pkwiu"),
  KLASYFIKACJA_PKOB: metadataField("pkob"),
  RODZAJ_WYROBU_AKCYZOWEGO: metadataField("exciseProductKind"),
  DATA_REJESTRACJI: metadataField("registeredAt"),
  KOMENTARZE_BIP: metadataField("bipComments"),
  KOM_BIP_OPIS: metadataField("bipCommentNote"),
  POZIOM_DOSTEPU_WYBRANEJ_TRESCI: excludedSourceField(
    "which of the service's editor groups may see a part of the document; it says nothing about the document",
  ),
  WYNIK_ANALIZY: metadataField("analysisResultId"),
  [`${TOP_PREFIX}id`]: excludedSourceField(
    "the same id ID_INFORMACJI states, which keys the row",
  ),
  [`${TOP_PREFIX}versionId`]: metadataField("versionId"),
  [`${TOP_PREFIX}nazwa`]: excludedSourceField(
    "the category's name, which KATEGORIA_INFORMACJI states",
  ),
  [`${TOP_PREFIX}szablonId`]: metadataField("templateId"),
  [`${TOP_PREFIX}wersjaSzablonuId`]: metadataField("templateVersionId"),
  [`${TOP_PREFIX}informacjaTytulDto`]: excludedSourceField(
    "an empty list on every document observed; the title is TEZA",
  ),
} as const satisfies Record<PlKisSourceField, SourceFieldDisposition>;

const KNOWN_FIELDS: ReadonlySet<string> = new Set(SOURCE_FIELDS);

/** The field names a listing row and a detail state, as the inventory names them. */
const fieldNamesOf = (
  row: Record<string, unknown> | undefined,
  detail: PlKisDetail | undefined,
): string[] => [
  ...new Set([
    ...Object.keys(row ?? {}),
    ...(detail === undefined ? [] : [...detail.fields.keys()]),
    ...(detail === undefined
      ? []
      : Object.keys(detail.top).map((key) => `${TOP_PREFIX}${key}`)),
  ]),
];

/**
 * Fields the service states that the inventory has not decided about.
 *
 * The service adds fields without notice; each one lands in the stored
 * envelope either way, and this names it so the inventory can catch up.
 */
export const plKisUnmappedFields = (
  row: Record<string, unknown> | undefined,
  detail: PlKisDetail | undefined,
): string[] =>
  fieldNamesOf(row, detail)
    .filter((name) => !KNOWN_FIELDS.has(name))
    .toSorted();

// ── Build ────────────────────────────────────────────────

const RAW_PART = {
  LISTING: "listing",
  DETAIL: "detail",
} as const;

const PDF_OBJECT = "document-pdf";

/** The envelope a crawl writes, so nothing else spells its part names. */
export const plKisRawPartsOf = (
  row: Record<string, unknown>,
  detailText: string | undefined,
): SourceRawParts => ({
  [RAW_PART.LISTING]: JSON.stringify(row),
  ...(detailText === undefined ? {} : { [RAW_PART.DETAIL]: detailText }),
});

export type AssemblePlKisOptions = {
  row: Record<string, unknown>;
  rawParts: SourceRawParts;
  /** Why the detail is missing, where it is. */
  detailStatus?: string | undefined;
  pdfBytes?: Uint8Array | undefined;
};

export type PlKisBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** Listed, and stored without its document: gone, unreadable or unaddressable. */
  | { type: "detail-unavailable"; decision: IngestionResult };

const readDetailPart = (parts: SourceRawParts): PlKisDetail | undefined => {
  const text = parts[RAW_PART.DETAIL];
  if (text === undefined) {
    return undefined;
  }
  return (
    readPlKisDetail(
      Result.try({
        try: (): unknown => JSON.parse(text),
        catch: () => null,
      }).unwrapOr(null),
    ) ?? undefined
  );
};

/**
 * The thesis the service prints over a document. A refused ruling whose
 * subject is withheld prints an elision there, which is no thesis.
 */
const thesisField = (thesis: string | undefined): TextField =>
  thesis?.replaceAll(/\s/gu, "") === "(...)"
    ? absentTextField(TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER)
    : sourceTextField(ADAPTER_KEYS.PL_KIS, thesis);

/** A field as the listing states it, or as the detail does where it does not. */
const statedString = (
  row: Record<string, unknown>,
  detail: PlKisDetail | undefined,
  key: string,
): string | undefined => optionalString(row[key]) ?? detailString(detail, key);

const statedDay = (
  row: Record<string, unknown>,
  detail: PlKisDetail | undefined,
  key: string,
): string | undefined =>
  plKisDay(optionalString(row[key])) ?? plKisDay(detailString(detail, key));

/**
 * What the categories other than an interpretation state: a ruling's validity
 * and classification, a general interpretation's place of publication.
 */
const supplementaryMetadata = (
  row: Record<string, unknown>,
  detail: PlKisDetail | undefined,
): Record<string, unknown> => {
  const attachments = detail?.fields.get("ZALACZNIKI")?.value;
  return {
    attachments: Array.isArray(attachments) ? attachments : [],
    officialPublication: statedString(row, detail, "MIEJ_PUB"),
    otherSourceUrl: statedString(row, detail, "INN_ZROD"),
    decisionKind: labelsOf(row["RODZAJ_DECYZJI"])[0],
    decisionKindId: detailString(detail, "RODZAJ_DECYZJI"),
    validFrom: statedDay(row, detail, "DAT_WAZ_OD"),
    validUntil: statedDay(row, detail, "DAT_WAZ_DO"),
    legalStateAsOf: statedDay(row, detail, "STAN_PRAW"),
    combinedNomenclature: labelsOf(row["NOMENKLATURA_SCALONA"]),
    combinedNomenclatureIds: detailIds(detail, "NOMENKLATURA_SCALONA"),
    pkwiu: labelsOf(row["KLASYFIKACJA_PKWIU"]),
    pkwiuIds: detailIds(detail, "KLASYFIKACJA_PKWIU"),
    pkob: labelsOf(row["KLASYFIKACJA_PKOB"]),
    pkobIds: detailIds(detail, "KLASYFIKACJA_PKOB"),
    exciseProductKind: labelsOf(row["RODZAJ_WYROBU_AKCYZOWEGO"])[0],
    registeredAt: statedDay(row, detail, "DATA_REJESTRACJI"),
    analysisResultId: detailString(detail, "WYNIK_ANALIZY"),
    bipComments: labelsOf(row["KOMENTARZE_BIP"]),
    bipCommentNote: statedString(row, detail, "KOM_BIP_OPIS"),
    versionId: detail?.top["versionId"],
    templateId: detail?.top["szablonId"],
    templateVersionId: detail?.top["wersjaSzablonuId"],
  };
};

/** The document the service links this one to, and how. */
const relatedDocumentsOf = (
  row: Record<string, unknown>,
  detail: PlKisDetail | undefined,
  category: IncludedCategory | undefined,
) => {
  const amended = statedString(row, detail, "INFORMACJA_ZMIENIANA");
  return amended === undefined || !DOCUMENT_ID_PATTERN.test(amended)
    ? []
    : [
        {
          relation: category?.relation ?? "amends",
          eurekaId: amended,
          sourceUrl: plKisWebUrl(amended),
        },
      ];
};

const detailProblemOf = (
  rawParts: SourceRawParts,
  detail: PlKisDetail | undefined,
): string | undefined => {
  if (rawParts[RAW_PART.DETAIL] === undefined) {
    return "detail-not-fetched";
  }
  return detail === undefined ? "detail-unreadable" : undefined;
};

type ParsedDocument = {
  output: ParsePlKisDocumentOutput;
  from: "html" | "pdf";
};

/** The document from its HTML field, or from the PDF where that is empty. */
const readDocument = async (
  input: ParsePlKisDocumentInput,
  html: string | undefined,
  pdfBytes: Uint8Array | undefined,
): Promise<ParsedDocument | undefined> => {
  if (html !== undefined) {
    return { output: parsePlKisDocumentHtml({ ...input, html }), from: "html" };
  }
  if (pdfBytes === undefined) {
    return undefined;
  }
  const read = await Result.tryPromise({
    try: async () => await parsePlKisDocumentPdf({ ...input, pdfBytes }),
    catch: errorTag,
  });
  if (Result.isOk(read)) {
    return { output: read.value, from: "pdf" };
  }
  logger.warn("case_law.ingestion.document_parse_failed", {
    adapterKey: ADAPTER_KEYS.PL_KIS,
    caseNumber: input.caseNumber,
    "error.type": read.error,
  });
  return undefined;
};

/**
 * Build one decision from the responses in hand.
 *
 * The crawl, the reconciliation walk and a replay of the stored envelope all
 * reach this with the same parts, so none of them can key or enrich a row
 * differently from the others.
 */
export const assemblePlKisDecision = async ({
  detailStatus,
  pdfBytes,
  rawParts,
  row,
}: AssemblePlKisOptions): Promise<PlKisBuildResult> => {
  const publisherId = plKisDocumentIdOf(row);
  const quarantineId = plKisQuarantineId(row);
  // A row stating no usable id is still a document the service counts: it is
  // kept under its quarantine key, without a detail nothing can address.
  const id = publisherId ?? quarantineId;
  const parsedDetail = readDetailPart(rawParts);
  // A detail naming another document is not this one's detail.
  const detail =
    publisherId !== undefined && parsedDetail?.id === publisherId
      ? parsedDetail
      : undefined;
  const detailProblem =
    publisherId === undefined
      ? "publisher-id-unavailable"
      : (detailStatus ?? detailProblemOf(rawParts, detail));

  const categoryId = detailString(detail, "KATEGORIA_INFORMACJI");
  const categoryLabels = labelsOf(row["KATEGORIA_INFORMACJI"]);
  const category =
    (categoryId === undefined
      ? undefined
      : plKisCategoryById(Number(categoryId))) ??
    categoryLabels.map(categoryByLabel).find((found) => found !== undefined);
  const includedCategory =
    category?.disposition === "included" ? category : undefined;

  // The service keeps a signature as typed, trailing blank included.
  const signature = statedString(row, detail, "SYG")?.trim();
  const caseNumber = signature ?? id;
  const authorities = labelsOf(row["AUTOR"]);
  // The issuing authority is the record's own field and nothing else: the
  // service holds documents of several authorities, so none is assumed.
  const court = authorities[0] ?? "";
  if (court.length === 0) {
    logger.warn("case_law.ingestion.court_not_stated", {
      adapterKey: ADAPTER_KEYS.PL_KIS,
      sourceDocumentId: id,
    });
  }
  const decisionDate = statedDay(row, detail, "DT_WYD");
  const decisionType =
    includedCategory?.decisionType ??
    categoryLabels[0]?.toLocaleLowerCase("pl-PL");
  const provisions = labelsOf(row["PRZEPISY"]).map(parsePlKisProvision);
  const issues = labelsOf(row["ZAGADNIENIA"]);
  const keywords = labelsOf(row["SLOWA_KLUCZOWE"]);
  const sourceUrl =
    publisherId === undefined ? undefined : plKisWebUrl(publisherId);
  const documentUrl =
    publisherId === undefined ? undefined : pdfUrl(publisherId);

  const html = detailString(detail, "TRESC_INTERESARIUSZ");
  const parseInput = {
    caseNumber,
    court,
    decisionDate,
    decisionType,
    sourceUrl: sourceUrl ?? "",
    documentUrl: documentUrl ?? "",
    documentId: id,
    keywords,
    statutes: provisions.map(({ raw }) => raw),
  };
  const parsed = await readDocument(parseInput, html, pdfBytes);
  const documentAst: DocumentAst | EmptyAst =
    parsed?.output.documentAst ?? EMPTY_AST;

  const unmapped = plKisUnmappedFields(row, detail);
  if (unmapped.length > 0) {
    logger.warn("case_law.ingestion.source_field_unmapped", {
      adapterKey: ADAPTER_KEYS.PL_KIS,
      fields: unmapped.join(", "),
    });
  }

  const statusId = detailString(detail, "STATUS_INFORMACJI");
  const statusLabels = labelsOf(row["STATUS_INFORMACJI"]);
  const sourceRaw = encodeSourceRawEnvelope(rawParts);
  const listingOnly = parsed === undefined;

  const decision: IngestionResult = {
    caseNumber,
    ...(signature === undefined
      ? { caseNumberIsPlaceholder: true }
      : { identifiers: [{ type: "case-number", value: signature }] }),
    sourceDocumentId: id,
    // The quarantine key keeps meeting the row stored while the id was
    // missing, so the observation that recovers it enriches that row.
    ...(publisherId === undefined
      ? {}
      : { sourceDocumentIdRepairAliases: [quarantineId] }),
    court,
    country: ADAPTER_MANIFESTS[ADAPTER_KEYS.PL_KIS].country,
    language: LANGUAGE,
    ...(decisionDate === undefined ? {} : { decisionDate }),
    ...(decisionType === undefined ? {} : { decisionType }),
    ...(parsed === undefined ? {} : { fulltext: parsed.output.fulltext }),
    ...(listingOnly ? { isListingOnly: true } : {}),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(documentUrl === undefined ? {} : { documentUrl }),
    textFields: {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      headnote: thesisField(statedString(row, detail, "TEZA")),
    },
    metadata: checkedDecisionMetadata({
      eurekaId: id,
      caseNumber,
      court,
      decisionDate,
      decisionType,
      category:
        category === undefined
          ? { id: categoryId, label: categoryLabels[0] }
          : {
              id: category.id,
              label: categoryLabels[0],
              disposition: category.disposition,
            },
      authorities,
      authorityIds: detailIds(detail, "AUTOR"),
      status: statusOf(statusId),
      statusId,
      statusLabel: statusLabels[0],
      publishedAt: statedDay(row, detail, "DATA_PUBLIKACJI"),
      keywords,
      keywordIds: detailIds(detail, "SLOWA_KLUCZOWE"),
      provisions,
      provisionIds: detailIds(detail, "PRZEPISY"),
      taxTags: [...new Set(provisions.flatMap(({ taxTags }) => taxTags))],
      issues: issues.map((label) => ({ path: issuePathOf(label), raw: label })),
      issueIds: detailIds(detail, "ZAGADNIENIA"),
      taxes: [
        ...new Set(issues.flatMap((label) => issuePathOf(label).slice(0, 1))),
      ],
      relatedDocuments: relatedDocumentsOf(row, detail, includedCategory),
      ...supplementaryMetadata(row, detail),
      ...(parsed === undefined ? {} : { documentFrom: parsed.from }),
      ...(unmapped.length === 0 ? {} : { unmappedSourceFields: unmapped }),
      ...(listingOnly
        ? { detailStatus: detailProblem ?? "document-empty" }
        : {}),
      sourceAttribution:
        "System Informacji Skarbowej EUREKA, Ministerstwo Finansów",
    }),
    // The PDF is stored beside the envelope rather than in it, so a corrected
    // rendition under an unchanged detail has to change the hash too.
    rawHash:
      parsed?.from === "pdf" && pdfBytes !== undefined
        ? hashContent(
            `${sourceRaw}\n${new Bun.CryptoHasher("sha256").update(pdfBytes).digest("hex")}`,
          )
        : hashContent(sourceRaw),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.PL_KIS],
    documentAst,
    sourceRaw,
    ...(parsed?.from === "pdf" && pdfBytes !== undefined
      ? {
          sourceRawObjects: {
            [PDF_OBJECT]: { bytes: pdfBytes, contentType: "application/pdf" },
          },
        }
      : {}),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
  return listingOnly
    ? { type: "detail-unavailable", decision }
    : { type: "built", decision };
};

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46];

const isPdf = (bytes: Uint8Array): boolean =>
  PDF_SIGNATURE.every((byte, index) => bytes[index] === byte);

type Fetched<T> = Result<T | undefined, AdapterFetchError>;

const fetchDetailText = async (
  id: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Fetched<string>> => {
  const response = await fetchEureka(
    detailUrl(id),
    { headers: { Accept: "application/json" } },
    signal,
  );
  if (response.status === 404 || response.status === 410) {
    return Result.ok(undefined);
  }
  if (!response.ok || response.bytes === null) {
    return Result.err(
      requestError(
        cursor,
        `detail answered ${response.status}`,
        response.status,
      ),
    );
  }
  return Result.ok(new TextDecoder().decode(response.bytes));
};

const fetchPdf = async (
  id: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Fetched<Uint8Array>> => {
  const response = await fetchEureka(
    pdfUrl(id),
    { headers: { Accept: "application/pdf" } },
    signal,
  );
  if (response.status === 404 || response.status === 410) {
    return Result.ok(undefined);
  }
  if (!response.ok || response.bytes === null) {
    return Result.err(
      requestError(cursor, `PDF answered ${response.status}`, response.status),
    );
  }
  return Result.ok(isPdf(response.bytes) ? response.bytes : undefined);
};

/**
 * Fetch a listed row's detail, and the PDF where the detail states no text,
 * then assemble it. A refused request is the row's failure, not its absence:
 * the caller holds its cursor and asks again.
 */
const buildPlKisDecision = async (
  row: Record<string, unknown>,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<PlKisBuildResult, AdapterFetchError>> => {
  const id = plKisDocumentIdOf(row);
  if (id === undefined) {
    return Result.ok(
      await assemblePlKisDecision({
        row,
        rawParts: plKisRawPartsOf(row, undefined),
      }),
    );
  }
  const detailText = await fetchDetailText(id, cursor, signal);
  if (Result.isError(detailText)) {
    return detailText;
  }
  if (detailText.value === undefined) {
    return Result.ok(
      await assemblePlKisDecision({
        row,
        rawParts: plKisRawPartsOf(row, undefined),
        detailStatus: "detail-gone",
      }),
    );
  }
  const rawParts = plKisRawPartsOf(row, detailText.value);
  const detail = readDetailPart(rawParts);
  let pdfBytes: Uint8Array | undefined;
  if (
    detail !== undefined &&
    detailString(detail, "TRESC_INTERESARIUSZ") === undefined
  ) {
    const pdf = await fetchPdf(id, cursor, signal);
    if (Result.isError(pdf)) {
      return pdf;
    }
    pdfBytes = pdf.value;
  }
  return Result.ok(await assemblePlKisDecision({ row, rawParts, pdfBytes }));
};

const reparsePlKisStoredRaw = async (
  stored: StoredRawReparseInput,
): Promise<StoredRawReparseOutcome> => {
  const read = readStoredRawListing({
    stored,
    part: RAW_PART.LISTING,
    identityOf: plKisStoredIdOf,
  });
  if (read.type === "rejected") {
    return read;
  }
  const detail = readDetailPart(read.parts);
  const objects = decodeSourceRawEnvelopeObjects(
    new TextDecoder().decode(stored.raw),
  );
  if (
    objects[PDF_OBJECT] !== undefined &&
    detailString(detail, "TRESC_INTERESARIUSZ") === undefined
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: "the document is the stored PDF, which a replay does not read",
    };
  }
  const built = await assemblePlKisDecision({
    row: read.listing,
    rawParts: read.parts,
  });
  return { type: "parsed", result: built.decision };
};

/** What the envelope states, read from the stored parts themselves. */
const listPlKisSourceFields = (parts: SourceRawParts): readonly string[] => {
  const row = Result.try({
    try: (): unknown => JSON.parse(parts[RAW_PART.LISTING] ?? "null"),
    catch: () => null,
  }).unwrapOr(null);
  return fieldNamesOf(isRecord(row) ? row : undefined, readDetailPart(parts));
};

/**
 * The service's surfaces for one document. The listing row and the detail are
 * kept; the PDF rendition only where the detail states no text.
 */
const SOURCE_SURFACES = [
  "listing",
  "detail",
  "document-pdf",
  "web-page",
] as const;

const PL_KIS_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface(RAW_PART.LISTING),
    detail: storedSourceSurface(RAW_PART.DETAIL),
    "document-pdf": excludedSourceSurface(
      "a rendition of the detail's own text, fetched and kept only for a document whose detail states none",
    ),
    "web-page": excludedSourceSurface(
      "the service's single-page application, which renders the detail kept above",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Months and slices ────────────────────────────────────

const MONTH_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})$/u;

const currentMonth = (now: Date): string =>
  Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO("Europe/Warsaw")
    .toPlainDate()
    .toString()
    .slice(0, 7);

const monthOf = (value: string): Temporal.PlainYearMonth | null => {
  if (!MONTH_PATTERN.test(value)) {
    return null;
  }
  return Result.try({
    try: () => Temporal.PlainYearMonth.from(value),
    catch: () => null,
  }).unwrapOr(null);
};

/** The inclusive issue-date bounds of one month. */
export const plKisMonthBounds = (
  month: string,
): { from: string; to: string } | null => {
  const parsed = monthOf(month);
  if (parsed === null) {
    return null;
  }
  return {
    from: parsed.toPlainDate({ day: 1 }).toString(),
    to: parsed.toPlainDate({ day: parsed.daysInMonth }).toString(),
  };
};

const stepMonth = (month: string, months: number): string =>
  (monthOf(month) ?? panic(`not a month: ${month}`)).add({ months }).toString();

const FIRST_SLUG = PL_KIS_INCLUDED_CATEGORIES[0]?.slug ?? panic("no category");
const LAST_SLUG =
  PL_KIS_INCLUDED_CATEGORIES.at(-1)?.slug ?? panic("no category");

/** `2026-09/01-ind`: an issue month and a category, sorting in walk order. */
export const plKisSlice = (month: string, slug: string): string =>
  `${month}/${slug}`;

const SLICE_PATTERN = /^(?<month>\d{4}-\d{2})\/(?<slug>[0-9a-z-]+)$/u;

export const parsePlKisSlice = (
  slice: string,
): { month: string; category: IncludedCategory } | null => {
  const groups = SLICE_PATTERN.exec(slice)?.groups;
  const month = groups?.["month"];
  const category = PL_KIS_INCLUDED_CATEGORIES.find(
    ({ slug }) => slug === groups?.["slug"],
  );
  return month === undefined ||
    category === undefined ||
    monthOf(month) === null
    ? null
    : { month, category };
};

const PL_KIS_FIRST_MONTH_SLICE = plKisSlice(FIRST_MONTH, FIRST_SLUG);

/**
 * The records that state no issue date, which no month lists. Sorts ahead of
 * every month, so the walk reaches it last going back and first going forward.
 */
export const PL_KIS_UNDATED_SLICE = "0000-00/00-undated";

const PL_KIS_FIRST_SLICE = PL_KIS_UNDATED_SLICE;

const sliceOf = (now: Date): string => plKisSlice(currentMonth(now), LAST_SLUG);

const slugIndex = (slug: string): number =>
  PL_KIS_INCLUDED_CATEGORIES.findIndex((category) => category.slug === slug);

export const plKisNextSlice = (
  slice: string,
  now = new Date(),
): string | null => {
  if (slice === PL_KIS_UNDATED_SLICE) {
    return PL_KIS_FIRST_MONTH_SLICE;
  }
  const parsed = parsePlKisSlice(slice);
  if (parsed === null) {
    return null;
  }
  const next = PL_KIS_INCLUDED_CATEGORIES[slugIndex(parsed.category.slug) + 1];
  const candidate =
    next === undefined
      ? plKisSlice(stepMonth(parsed.month, 1), FIRST_SLUG)
      : plKisSlice(parsed.month, next.slug);
  return candidate > sliceOf(now) ? null : candidate;
};

export const plKisPreviousSlice = (slice: string): string | null => {
  if (slice === PL_KIS_UNDATED_SLICE) {
    return null;
  }
  const parsed = parsePlKisSlice(slice);
  if (parsed === null) {
    return null;
  }
  const previous =
    PL_KIS_INCLUDED_CATEGORIES[slugIndex(parsed.category.slug) - 1];
  const candidate =
    previous === undefined
      ? plKisSlice(stepMonth(parsed.month, -1), LAST_SLUG)
      : plKisSlice(parsed.month, previous.slug);
  return candidate < PL_KIS_FIRST_MONTH_SLICE
    ? PL_KIS_UNDATED_SLICE
    : candidate;
};

/**
 * The last three issue months of every category: a document is published
 * days to weeks after it is issued, so a recent month keeps growing.
 */
const TIP_WINDOW_SLICES = 3 * PL_KIS_INCLUDED_CATEGORIES.length;

type UndatedPage = {
  /** The page's records that state no issue date, in id order. */
  rows: Record<string, unknown>[];
  /** How many records state none: the listed total less the dated count. */
  undated: number;
  url: string;
};

/**
 * One page of the records that state no issue date.
 *
 * The service has no filter for a missing date, so the page is the head of
 * the listing sorted by issue date, where undated records come first, cut at
 * the count the listing and a dated-only count differ by. A dated record
 * inside that cut means the ordering this relies on no longer holds, which is
 * a failure rather than a page.
 */
export const listPlKisUndatedPage = async (
  page: number,
  size: number,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<UndatedPage, AdapterFetchError>> => {
  const listed = await search(
    { categories: INCLUDED_IDS, sort: SORT.UNDATED_FIRST, page, size },
    cursor,
    signal,
  );
  if (Result.isError(listed)) {
    return listed;
  }
  if (plKisPageIsShort(listed.value, page, size)) {
    return Result.err(
      requestError(
        cursor,
        `undated page ${page} listed fewer rows than its count promises`,
      ),
    );
  }
  const dated = await search(
    {
      categories: INCLUDED_IDS,
      issuedFrom: EVERY_ISSUE_DATE.from,
      issuedTo: EVERY_ISSUE_DATE.to,
      sort: SORT.ID_ASC,
      page: 0,
      size: 1,
    },
    cursor,
    signal,
  );
  if (Result.isError(dated)) {
    return dated;
  }
  // A record published between the two requests can make the dated count
  // the larger; the undated head is then read as empty and the ledger's
  // next pass over this slice reads it again.
  const undated = Math.max(0, listed.value.totalHits - dated.value.totalHits);
  if (undated >= PL_KIS_RESULT_WINDOW) {
    return Result.err(
      requestError(
        cursor,
        `${undated} undated records, past the search's window`,
      ),
    );
  }
  const rows = listed.value.rows.slice(
    0,
    Math.max(0, Math.min(size, undated - page * size)),
  );
  if (rows.some((row) => optionalString(row["DT_WYD"]) !== undefined)) {
    return Result.err(
      requestError(
        cursor,
        "the undated head of the listing holds a dated record",
      ),
    );
  }
  return Result.ok({ rows, undated, url: listed.value.url });
};

const listPlKisSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  if (slice === PL_KIS_UNDATED_SLICE) {
    const undated = await listPlKisUndatedPage(
      page,
      RECONCILIATION_PAGE_SIZE,
      slice,
      signal,
    );
    if (Result.isError(undated)) {
      return await Promise.reject(undated.error);
    }
    return {
      items: undated.value.rows.map((row) => ({
        identity: plKisListingIdentity(row),
        payload: row,
      })),
      totalPages: Math.ceil(undated.value.undated / RECONCILIATION_PAGE_SIZE),
    };
  }
  const parsed = parsePlKisSlice(slice);
  const bounds = parsed === null ? null : plKisMonthBounds(parsed.month);
  if (parsed === null || bounds === null) {
    return await Promise.reject(
      requestError(slice, `slice is not a month and a category: ${slice}`),
    );
  }
  const listed = await search(
    {
      categories: [parsed.category.id],
      issuedFrom: bounds.from,
      issuedTo: bounds.to,
      sort: SORT.ID_ASC,
      page,
      size: RECONCILIATION_PAGE_SIZE,
    },
    slice,
    signal,
  );
  if (Result.isError(listed)) {
    return await Promise.reject(listed.error);
  }
  const { rows, totalHits } = listed.value;
  if (plKisPageIsShort(listed.value, page, RECONCILIATION_PAGE_SIZE)) {
    return await Promise.reject(
      requestError(
        slice,
        `page ${page} listed ${rows.length} of the rows its count of ${totalHits} promises`,
      ),
    );
  }
  if (totalHits >= PL_KIS_RESULT_WINDOW) {
    return await Promise.reject(
      requestError(
        slice,
        `slice reports ${totalHits} rows, past the search's window; it cannot be listed to its end`,
      ),
    );
  }
  return {
    items: rows.map((row) => ({
      identity: plKisListingIdentity(row),
      payload: row,
    })),
    totalPages: Math.ceil(totalHits / RECONCILIATION_PAGE_SIZE),
  };
};

const buildPlKisFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isRecord(payload)) {
    return { type: "unkeyable" };
  }
  const attempted = await buildPlKisDecision(payload, null, signal);
  if (Result.isError(attempted)) {
    return await Promise.reject(attempted.error);
  }
  const built = attempted.value;
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "detail-unavailable":
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled pl-kis build result: ${JSON.stringify(built)}`);
    }
  }
};

// ── Crawl cursor ─────────────────────────────────────────

export type PlKisCursor =
  /** The records with no issue date, read before the months. */
  | { phase: "undated"; boundary: string; page: number }
  | { phase: "sweep"; boundary: string; month: string; page: number }
  | { phase: "tip"; walk: "head"; frontier: string }
  | {
      phase: "tip";
      walk: "catch-up";
      frontier: string;
      /** The newest id this walk has read: the frontier it banks when done. */
      pending: string;
      page: number;
    };

const SEPARATOR = "|";

export const encodePlKisCursor = (cursor: PlKisCursor): string => {
  if (cursor.phase === "undated") {
    return ["undated", cursor.boundary, String(cursor.page)].join(SEPARATOR);
  }
  if (cursor.phase === "sweep") {
    return ["sweep", cursor.boundary, cursor.month, String(cursor.page)].join(
      SEPARATOR,
    );
  }
  return cursor.walk === "head"
    ? ["tip", "head", cursor.frontier].join(SEPARATOR)
    : [
        "tip",
        "catch-up",
        cursor.frontier,
        cursor.pending,
        String(cursor.page),
      ].join(SEPARATOR);
};

const isId = (value: string | undefined): value is string =>
  value !== undefined && DOCUMENT_ID_PATTERN.test(value);

const pageOf = (value: string | undefined): number | null => {
  const page = Number(value);
  return value !== undefined &&
    /^\d+$/u.test(value) &&
    Number.isSafeInteger(page)
    ? page
    : null;
};

/**
 * Read a persisted cursor, or `null` for one this adapter does not write,
 * which means "take the boundary and start the sweep".
 */
export const parsePlKisCursor = (cursor: string | null): PlKisCursor | null => {
  if (cursor === null) {
    return null;
  }
  const parts = cursor.split(SEPARATOR);
  const [phase, second, third, fourth, fifth] = parts;
  if (phase === "undated" && parts.length === 3) {
    const page = pageOf(third);
    return isId(second) && page !== null
      ? { phase: "undated", boundary: second, page }
      : null;
  }
  if (phase === "sweep" && parts.length === 4) {
    const page = pageOf(fourth);
    return isId(second) &&
      third !== undefined &&
      monthOf(third) !== null &&
      third >= FIRST_MONTH &&
      page !== null
      ? { phase: "sweep", boundary: second, month: third, page }
      : null;
  }
  if (phase !== "tip") {
    return null;
  }
  if (second === "head" && parts.length === 3) {
    return isId(third) ? { phase: "tip", walk: "head", frontier: third } : null;
  }
  const page = pageOf(fifth);
  return second === "catch-up" &&
    parts.length === 5 &&
    isId(third) &&
    isId(fourth) &&
    page !== null &&
    page > 0
    ? { phase: "tip", walk: "catch-up", frontier: third, pending: fourth, page }
    : null;
};

/** Numeric order of two ids the pattern above accepted. */
const idAtOrBelow = (id: string, frontier: string): boolean =>
  BigInt(id) <= BigInt(frontier);

/** The newest document id the service lists, in one request. */
const readBoundary = async (
  signal?: AbortSignal,
): Promise<Result<string, AdapterFetchError>> => {
  const listed = await search(
    { categories: INCLUDED_IDS, sort: SORT.ID_DESC, page: 0, size: 1 },
    "boundary",
    signal,
  );
  if (Result.isError(listed)) {
    return listed;
  }
  const newest = listed.value.rows.map(plKisDocumentIdOf).find(isId);
  return newest === undefined
    ? Result.err(requestError("boundary", "the search lists no document"))
    : Result.ok(newest);
};

type Collected = { decisions: IngestionResult[]; aborted: boolean };

const collectDecisions = async (
  rows: Record<string, unknown>[],
  cursor: string,
  signal?: AbortSignal,
): Promise<Result<Collected, AdapterFetchError>> => {
  const decisions: IngestionResult[] = [];
  for (const row of rows) {
    if (signal?.aborted) {
      return Result.ok({ decisions, aborted: true });
    }
    const attempted = await buildPlKisDecision(row, cursor, signal);
    if (Result.isError(attempted)) {
      return attempted;
    }
    // The crawl keeps a listing-only row; only the reconciliation refuses it.
    decisions.push(attempted.value.decision);
  }
  return Result.ok({ decisions, aborted: false });
};

const sweepPage = async (
  start: Extract<PlKisCursor, { phase: "sweep" }>,
  now: Date,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  let { month, page } = start;
  let url: string | undefined;
  const tip = (): string =>
    encodePlKisCursor({ phase: "tip", walk: "head", frontier: start.boundary });
  const nextMonth = (): string | null => {
    const next = stepMonth(month, 1);
    return next > currentMonth(now) ? null : next;
  };

  for (let step = 0; step <= MAX_EMPTY_WINDOW_SKIPS; step += 1) {
    const cursor = encodePlKisCursor({ ...start, month, page });
    const bounds =
      plKisMonthBounds(month) ?? panic("validated sweep month became invalid");
    const listed = await search(
      {
        categories: INCLUDED_IDS,
        issuedFrom: bounds.from,
        issuedTo: bounds.to,
        sort: SORT.ID_ASC,
        page,
        size: CRAWL_PAGE_SIZE,
      },
      cursor,
      signal,
    );
    if (Result.isError(listed)) {
      return listed;
    }
    const { rows, totalHits } = listed.value;
    url = listed.value.url;
    if (plKisPageIsShort(listed.value, page, CRAWL_PAGE_SIZE)) {
      return Result.err(
        requestError(
          cursor,
          `page ${page} of month ${month} listed ${rows.length} of the rows its count of ${totalHits} promises`,
        ),
      );
    }
    if (totalHits >= PL_KIS_RESULT_WINDOW) {
      return Result.err(
        requestError(
          cursor,
          `month ${month} reports ${totalHits} rows, past the search's window`,
        ),
      );
    }
    if (rows.length > 0) {
      const collected = await collectDecisions(rows, cursor, signal);
      if (Result.isError(collected)) {
        return collected;
      }
      const { aborted, decisions } = collected.value;
      if (aborted) {
        return Result.ok({ decisions, sourceUrl: url, nextCursor: cursor });
      }
      if ((page + 1) * CRAWL_PAGE_SIZE < totalHits) {
        return Result.ok({
          decisions,
          sourceUrl: url,
          nextCursor: encodePlKisCursor({ ...start, month, page: page + 1 }),
        });
      }
      const after = nextMonth();
      return Result.ok({
        decisions,
        sourceUrl: url,
        nextCursor:
          after === null
            ? tip()
            : encodePlKisCursor({ ...start, month: after, page: 0 }),
      });
    }
    const after = nextMonth();
    if (after === null) {
      return Result.ok({ decisions: [], sourceUrl: url, nextCursor: tip() });
    }
    month = after;
    page = 0;
  }
  return Result.ok({
    decisions: [],
    ...(url === undefined ? {} : { sourceUrl: url }),
    nextCursor: encodePlKisCursor({ ...start, month, page }),
  });
};

const tipPage = async (
  start: Extract<PlKisCursor, { phase: "tip" }>,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const cursor = encodePlKisCursor(start);
  const page = start.walk === "head" ? 0 : start.page;
  const listed = await search(
    {
      categories: INCLUDED_IDS,
      sort: SORT.ID_DESC,
      page,
      size: CRAWL_PAGE_SIZE,
    },
    cursor,
    signal,
  );
  if (Result.isError(listed)) {
    return listed;
  }
  const { rows, url } = listed.value;
  if (plKisPageIsShort(listed.value, page, CRAWL_PAGE_SIZE)) {
    return Result.err(
      requestError(
        cursor,
        `tip page ${page} listed ${rows.length} of the rows its count promises`,
      ),
    );
  }
  const fresh: Record<string, unknown>[] = [];
  let reachedFrontier = rows.length < CRAWL_PAGE_SIZE;
  for (const row of rows) {
    const id = plKisDocumentIdOf(row);
    if (id !== undefined && idAtOrBelow(id, start.frontier)) {
      reachedFrontier = true;
      break;
    }
    fresh.push(row);
  }
  const pending =
    start.walk === "catch-up"
      ? start.pending
      : (fresh.map(plKisDocumentIdOf).find(isId) ?? start.frontier);
  const caughtUp = (): string =>
    encodePlKisCursor({ phase: "tip", walk: "head", frontier: pending });

  if (fresh.length === 0) {
    return Result.ok({
      decisions: [],
      sourceUrl: url,
      nextCursor: start.walk === "head" ? cursor : caughtUp(),
    });
  }
  const collected = await collectDecisions(fresh, cursor, signal);
  if (Result.isError(collected)) {
    return collected;
  }
  const { aborted, decisions } = collected.value;
  if (aborted) {
    return Result.ok({ decisions, sourceUrl: url, nextCursor: cursor });
  }
  if (reachedFrontier) {
    return Result.ok({ decisions, sourceUrl: url, nextCursor: caughtUp() });
  }
  if ((page + 2) * CRAWL_PAGE_SIZE > PL_KIS_RESULT_WINDOW) {
    // The next page is past what the search serves. The rows between here and
    // the frontier belong to the reconciliation ledger, whose recent slices
    // list them by issue month; the tip resumes at the head.
    logger.warn("case_law.ingestion.tip_catch_up_window_exhausted", {
      adapterKey: ADAPTER_KEYS.PL_KIS,
      frontier: start.frontier,
      pending,
    });
    return Result.ok({ decisions, sourceUrl: url, nextCursor: caughtUp() });
  }
  // A descending listing grows only at its head, so the next page can re-read
  // a row but cannot step over one.
  return Result.ok({
    decisions,
    sourceUrl: url,
    nextCursor: encodePlKisCursor({
      phase: "tip",
      walk: "catch-up",
      frontier: start.frontier,
      pending,
      page: page + 1,
    }),
  });
};

/**
 * The records with no issue date, before the months. They are in no month
 * window, and the tip reads only ids past the boundary, so a record that
 * already existed when the sweep began is reached here or nowhere.
 */
const undatedPage = async (
  start: Extract<PlKisCursor, { phase: "undated" }>,
  now: Date,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const cursor = encodePlKisCursor(start);
  const listed = await listPlKisUndatedPage(
    start.page,
    CRAWL_PAGE_SIZE,
    cursor,
    signal,
  );
  if (Result.isError(listed)) {
    return listed;
  }
  const { rows, undated, url } = listed.value;
  const sweep = {
    phase: "sweep",
    boundary: start.boundary,
    month: FIRST_MONTH,
    page: 0,
  } as const;
  if (rows.length === 0) {
    return await sweepPage(sweep, now, signal);
  }
  const collected = await collectDecisions(rows, cursor, signal);
  if (Result.isError(collected)) {
    return collected;
  }
  const { aborted, decisions } = collected.value;
  if (aborted) {
    return Result.ok({ decisions, sourceUrl: url, nextCursor: cursor });
  }
  return Result.ok({
    decisions,
    sourceUrl: url,
    nextCursor: encodePlKisCursor(
      (start.page + 1) * CRAWL_PAGE_SIZE < undated
        ? { ...start, page: start.page + 1 }
        : sweep,
    ),
  });
};

const plKisFetchPage = async (
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const now = new Date();
  const parsed = parsePlKisCursor(cursor);
  if (parsed === null) {
    const boundary = await readBoundary(signal);
    if (Result.isError(boundary)) {
      return boundary;
    }
    return await undatedPage(
      { phase: "undated", boundary: boundary.value, page: 0 },
      now,
      signal,
    );
  }
  switch (parsed.phase) {
    case "undated":
      return await undatedPage(parsed, now, signal);
    case "sweep":
      return await sweepPage(parsed, now, signal);
    case "tip":
      return await tipPage(parsed, signal);
    default: {
      parsed satisfies never;
      return panic(`Unhandled pl-kis cursor: ${JSON.stringify(parsed)}`);
    }
  }
};

/** What the service lists across every ingested category, in one request. */
const plKisTotalCount = async (
  signal: AbortSignal,
): Promise<SourceTotalCount> => {
  const listed = await Result.tryPromise({
    try: async () =>
      await search(
        { categories: INCLUDED_IDS, sort: SORT.ID_DESC, page: 0, size: 1 },
        "total",
        signal,
      ),
    catch: errorTag,
  });
  if (Result.isError(listed)) {
    return { type: "probe-failed", errorTag: listed.error };
  }
  return Result.isError(listed.value)
    ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS)
    : sourceTotalRead(listed.value.value.totalHits);
};

// ── Adapter ──────────────────────────────────────────────

export const plKisAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.PL_KIS,
  language: LANGUAGE,
  minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
  // One listing request and up to two requests per row behind a one-second
  // gate, each retried through the service's unanswered requests.
  pageTimeoutMs: 10 * 60_000,
  maxCycleMs: 20 * 60_000,
  maxSyncPages: 10,

  reparseStoredRaw: reparsePlKisStoredRaw,

  sourceSurfaces: PL_KIS_SOURCE_SURFACES,

  sourceFields: {
    status: "declared",
    fields: PL_KIS_SOURCE_FIELDS,
    listSourceFields: listPlKisSourceFields,
  },

  getTotalCount: plKisTotalCount,

  reconciliation: {
    firstSlice: PL_KIS_FIRST_SLICE,
    sliceOf,
    nextSlice: (slice) => plKisNextSlice(slice),
    previousSlice: plKisPreviousSlice,
    tipWindowDays: TIP_WINDOW_SLICES,
    heldRequiresDetail: true,
    listSlicePage: listPlKisSlicePage,
    buildDecision: buildPlKisFromPayload,
  },

  async fetchPage(cursor, _config, signal) {
    return Result.flatten(
      await Result.tryPromise({
        try: async () => await plKisFetchPage(cursor, signal),
        catch: adapterCatch(ADAPTER_KEYS.PL_KIS, cursor),
      }),
    );
  },
});
