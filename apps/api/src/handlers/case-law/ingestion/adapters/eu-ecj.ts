import { panic, Result } from "better-result";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  defineSourceAdapter,
  EMPTY_AST,
  isPersistableSourceDocumentId,
  STORED_RAW_REPARSE_REJECTION,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import type { ParseEcjDecisionInput } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj";
import {
  ecjDocumentHtml,
  ecjKeywordSpacingNeedsVerbatim,
  parseEcjDecisionHtml,
} from "@/api/handlers/case-law/ingestion/parsers/eu-ecj";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import { captureError } from "@/api/lib/analytics/capture";
import {
  AdapterFetchError,
  TelemetryError,
} from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { fetchWithTimeout } from "@/api/lib/fetch";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

/**
 * European Court of Justice (CJEU) adapter.
 *
 * Uses the Cellar SPARQL endpoint (no auth) to discover
 * decisions and Cellar's own content streams for their text.
 *
 * Flow:
 * 1. SPARQL query with date filter to list ECLIs + CELEX
 *    numbers for the cursor date range.
 * 2. For each available language, fetch the XHTML manifestation directly
 *    from Cellar's machine-to-machine content endpoint.
 *
 * Cursor format: ISO date string (YYYY-MM-DD). Each page
 * covers one day; null cursor starts 7 days ago.
 *
 * The SPARQL endpoint returns structured metadata (ECLI,
 * date, CELEX, decision type) directly — no HTML scraping
 * needed for the list.
 */

const SPARQL_URL = "https://publications.europa.eu/webapi/rdf/sparql";
const CELLAR_RESOURCE_PREFIX = "http://publications.europa.eu/resource/cellar/";
const CELLAR_LANGUAGE_PREFIX =
  "http://publications.europa.eu/resource/authority/language/";
// Digit runs are unbounded on purpose: Cellar's version/manifestation
// padding is an upstream detail, and the charset alone already rules out
// path traversal in the URL we build from this.
const CELLAR_MANIFESTATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+\.\d+$/u;

/**
 * All 24 official EU languages. EUR-Lex publishes CJEU
 * decisions in each; we fetch all and skip 404s for
 * translations not yet available.
 */
export const ECJ_LANGUAGES = [
  "BG",
  "CS",
  "DA",
  "DE",
  "EL",
  "EN",
  "ES",
  "ET",
  "FI",
  "FR",
  "GA",
  "HR",
  "HU",
  "IT",
  "LT",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SL",
  "SV",
] as const;

type EcjLanguage = (typeof ECJ_LANGUAGES)[number];

const eurLexSourceUrl = (lang: EcjLanguage, celex: string) =>
  `https://eur-lex.europa.eu/legal-content/${lang}` +
  `/ALL/?uri=CELEX:${celex}`;

// Intl.Locale construction is not free and SPARQL pages repeat the same
// 24 language URIs thousands of times during backfills; memoize per
// Cellar code (misses included).
const ecjLanguageCache = new Map<string, EcjLanguage | undefined>();

const toEcjLanguage = (languageUri: string): EcjLanguage | undefined => {
  if (!languageUri.startsWith(CELLAR_LANGUAGE_PREFIX)) {
    return undefined;
  }
  const cellarCode = languageUri.slice(CELLAR_LANGUAGE_PREFIX.length);
  if (!/^[A-Z]{3}$/u.test(cellarCode)) {
    return undefined;
  }
  if (ecjLanguageCache.has(cellarCode)) {
    return ecjLanguageCache.get(cellarCode);
  }
  const language = new Intl.Locale(
    cellarCode.toLowerCase(),
  ).language.toUpperCase();
  const resolved = ECJ_LANGUAGES.find((supported) => supported === language);
  ecjLanguageCache.set(cellarCode, resolved);
  return resolved;
};

const toCellarContentUrl = (manifestationUri: string): string | undefined => {
  if (!manifestationUri.startsWith(CELLAR_RESOURCE_PREFIX)) {
    return undefined;
  }
  const manifestationId = manifestationUri.slice(CELLAR_RESOURCE_PREFIX.length);
  if (!CELLAR_MANIFESTATION_ID.test(manifestationId)) {
    // A Cellar-prefixed URI that fails validation means the upstream ID
    // format changed; surface it instead of silently dropping the variant.
    logger.warn("case_law.ingestion.unexpected_cellar_manifestation_id", {
      manifestationUri,
    });
    return undefined;
  }
  // Addressed as the manifestation itself, with the format asked for by
  // content negotiation. `DOC_1` names the first item of the manifestation,
  // and the XHTML is not always the first: older works expose it at a later
  // ordinal, so a fixed item number 404s on documents Cellar does serve.
  return `https://publications.europa.eu/resource/cellar/${manifestationId}`;
};

// -- SPARQL --

type SparqlBinding = {
  value: string;
  type: string;
};

type SparqlResult = {
  ecli: SparqlBinding;
  date: SparqlBinding;
  celex: SparqlBinding;
  type: SparqlBinding;
  language: SparqlBinding;
  manifestation: SparqlBinding;
};

type SparqlResponse = {
  results: {
    bindings: SparqlResult[];
  };
};

const isSparqlBinding = (value: unknown): value is SparqlBinding =>
  isRecord(value) &&
  typeof value["value"] === "string" &&
  typeof value["type"] === "string";

const isSparqlResult = (value: unknown): value is SparqlResult =>
  isRecord(value) &&
  isSparqlBinding(value["ecli"]) &&
  isSparqlBinding(value["date"]) &&
  isSparqlBinding(value["celex"]) &&
  isSparqlBinding(value["type"]) &&
  isSparqlBinding(value["language"]) &&
  isSparqlBinding(value["manifestation"]);

const isSparqlResponse = (value: unknown): value is SparqlResponse =>
  isRecord(value) &&
  isRecord(value["results"]) &&
  Array.isArray(value["results"]["bindings"]) &&
  value["results"]["bindings"].every(isSparqlResult);

/**
 * Bindings one response may carry. Exported because it is part of this
 * adapter's listing contract rather than an internal detail: every caller that
 * chunks a query sizes its chunk to stay under it, and a test that proves a
 * capped response is refused has to reach exactly this many bindings.
 */
export const SPARQL_LIMIT = 10_000;

const CDM_TYPE_MAP: Record<string, string> = {
  "http://publications.europa.eu/ontology/cdm#judgement": "judgment",
  "http://publications.europa.eu/ontology/cdm#order": "order",
  "http://publications.europa.eu/ontology/cdm#order_cjeu": "order",
  "http://publications.europa.eu/ontology/cdm#opinion_advocate_general":
    "opinion",
  "http://publications.europa.eu/ontology/cdm#opinion_advocate-general":
    "opinion",
};

/**
 * Query the Cellar SPARQL endpoint for CJEU decisions
 * within a date range.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * What a query does when Cellar answers with exactly `SPARQL_LIMIT` bindings,
 * which is indistinguishable from a listing cut off at the cap.
 */
const SPARQL_TRUNCATION = {
  /**
   * Refuse the page. Every caller that treats the listing as the statement of
   * what exists — the census, a re-fetch, a slice walk — would otherwise read
   * the bindings the cap left out as never published, and a partial listing
   * banked as complete reads as settled.
   */
  REFUSE: "refuse",
  /**
   * Record it and continue. The crawl's per-day window sits orders of
   * magnitude below the cap, so reaching it means the source changed shape
   * rather than that this page is short.
   */
  WARN: "warn",
} as const;

type SparqlTruncation =
  (typeof SPARQL_TRUNCATION)[keyof typeof SPARQL_TRUNCATION];

/**
 * Budget for one bulk listing query: a census chunk, a re-fetch's pre-flight,
 * a reconciliation slice page.
 *
 * Stated here so the callers that need it cannot state it separately and be
 * overruled: a caller's `AbortSignal` and this budget both bound the request,
 * so the shorter one wins, and a caller passing a 60s signal to a query
 * hardcoded at 10s gets 10s while its own constant says otherwise.
 *
 * Generous next to the measured cost — a month-wide listing answers in around
 * two seconds — because the callers are bulk operations without retries, where
 * one slow response ends a run that has to start over. The live crawl keeps
 * the tighter per-request default: its per-day pages are small, and a crawl
 * that stalls should fail and move its cursor on.
 */
export const ECJ_LISTING_TIMEOUT_MS = 60_000;

type QueryDecisionsOptions = {
  dateFrom: string;
  dateTo: string;
  signal: AbortSignal;
  /**
   * Budget for this request. Bounds it together with `signal`, so a caller
   * gets the shorter of the two rather than whichever the query happens to
   * hardcode.
   */
  timeoutMs: number;
  /** How a response that reached the binding cap is treated. */
  truncation: SparqlTruncation;
  /**
   * Restrict the page to these CELEX numbers. Used to record fixtures
   * for named decisions through the same query the crawl runs, instead
   * of crawling a whole publication day to reach them.
   */
  celexFilter?: readonly string[];
};

/** CELEX numbers are alphanumeric with optional bracketed suffixes. */
const CELEX = /^[0-9A-Z()]+$/u;

/** Boundary check for callers that accept CELEX numbers as input. */
export const isValidCelex = (value: string): boolean => CELEX.test(value);

const queryDecisions = async ({
  dateFrom,
  dateTo,
  signal,
  timeoutMs,
  truncation,
  celexFilter,
}: QueryDecisionsOptions): Promise<SparqlResult[]> => {
  if (!ISO_DATE.test(dateFrom) || !ISO_DATE.test(dateTo)) {
    throw new AdapterFetchError({
      message: `Invalid date format: ${dateFrom} / ${dateTo}`,
      adapterKey: ADAPTER_KEYS.EU_ECJ,
      cursor: dateFrom,
    });
  }

  const invalidCelex = celexFilter?.find((celex) => !CELEX.test(celex));
  if (invalidCelex !== undefined) {
    throw new AdapterFetchError({
      message: `Invalid CELEX number: ${invalidCelex}`,
      adapterKey: ADAPTER_KEYS.EU_ECJ,
      cursor: dateFrom,
    });
  }

  const celexClause =
    celexFilter && celexFilter.length > 0
      ? `\n  FILTER(STR(?celex) IN (${celexFilter.map((celex) => `"${celex}"`).join(", ")}))`
      : "";

  const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?ecli ?date ?celex ?type ?language ?manifestation
WHERE {
  ?doc cdm:case-law_ecli ?ecli .
  ?doc cdm:work_date_document ?date .
  ?doc cdm:resource_legal_id_celex ?celex .
  ?doc a ?type .
  ?expression cdm:expression_belongs_to_work ?doc .
  ?expression cdm:expression_uses_language ?language .
  ?manifestation cdm:manifestation_manifests_expression ?expression .
  ?manifestation cdm:manifestation_type ?manifestationType .
  FILTER(?type IN (
    cdm:judgement,
    cdm:order,
    cdm:order_cjeu,
    cdm:opinion_advocate_general,
    cdm:opinion_advocate-general
  ))
  FILTER(STR(?manifestationType) = "xhtml")
  FILTER(STR(?date) >= "${dateFrom}")
  FILTER(STR(?date) <= "${dateTo}")${celexClause}
}
ORDER BY ASC(?date) ASC(?celex) ASC(?language)
LIMIT ${SPARQL_LIMIT}`.trim();

  const response = await fetchWithTimeout(SPARQL_URL, {
    method: "POST",
    signal,
    timeoutMs,
    headers: {
      Accept: "application/sparql-results+json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": INGESTION_USER_AGENT,
    },
    body: new URLSearchParams({ query }).toString(),
  });

  if (!response.ok) {
    throw new AdapterFetchError({
      message: `CJEU SPARQL error: ${response.status}`,
      adapterKey: ADAPTER_KEYS.EU_ECJ,
      cursor: dateFrom,
      httpStatus: response.status,
    });
  }

  const json = await response.json();
  if (!isSparqlResponse(json)) {
    throw new AdapterFetchError({
      message: "CJEU SPARQL returned an invalid payload",
      adapterKey: ADAPTER_KEYS.EU_ECJ,
      cursor: dateFrom,
      httpStatus: response.status,
    });
  }
  const bindings = json.results.bindings;

  if (bindings.length === SPARQL_LIMIT) {
    if (truncation === SPARQL_TRUNCATION.REFUSE) {
      throw new AdapterFetchError({
        message: `CJEU SPARQL listing truncated at ${SPARQL_LIMIT} bindings for ${dateFrom}..${dateTo}; narrow the date range or the CELEX chunk`,
        adapterKey: ADAPTER_KEYS.EU_ECJ,
        cursor: dateFrom,
      });
    }
    logger.warn("case_law.ingestion.sparql_limit_hit", {
      adapterKey: ADAPTER_KEYS.EU_ECJ,
      limit: SPARQL_LIMIT,
      date: dateFrom,
    });
  }

  return bindings;
};

// -- CELEX to case number --

/**
 * Parse a CELEX number into a human-readable case number.
 *
 * CELEX sector 6 format: 6{year}{type}{number}
 * e.g. "62024CJ0436" → "C-436/24"
 *      "62023TJ0201" → "T-201/23"
 */
export const celexToCaseNumber = (celex: string): string => {
  const match = /^6(?<year>\d{4})(?<type>CJ|TJ|CC|CO|TO|FJ)(?<num>\d+)/u.exec(
    celex,
  );
  if (!match) {
    return celex;
  }

  const { year: yearStr, type: typeStr, num: numStr } = match.groups ?? {};
  if (!yearStr || !typeStr || !numStr) {
    return celex;
  }
  const year = yearStr.slice(2); // "2024" → "24"
  const caseNum = Number.parseInt(numStr, 10);
  const CELEX_PREFIX: Record<string, string> = {
    CJ: "C",
    CC: "C",
    CO: "C",
    TJ: "T",
    TO: "T",
    FJ: "F",
  };
  const prefix = CELEX_PREFIX[typeStr] ?? "C";

  return `${prefix}-${caseNum}/${year}`;
};

/** One language variant of one decision, as Cellar lists it. */
export type EcjCelexVariant = {
  celex: string;
  language: EcjLanguage;
};

/**
 * The language tag a stored row carries, from the Cellar language this
 * publisher lists. Cellar states languages in upper case and the schema stores
 * them lower; the fallback identity index is keyed on the stored form, so the
 * conversion lives here rather than at each call site.
 */
const ecjRowLanguage = (language: EcjLanguage): string =>
  language.toLowerCase();

/**
 * The identity a stored row carries: the publisher's CELEX number and the
 * language of the manifestation the row holds.
 *
 * The CELEX alone would not do, because this source stores one row per
 * language variant of a document — the same judgment in 24 languages is 24
 * rows, and a single identity for all of them would let each translation
 * overwrite the last. The docket alone would not either, and that is the
 * defect this replaces: several documents settle one docket (an opinion, a
 * judgment and an order all numbered C-100/23), so `(caseNumber, language)`
 * named a docket rather than a document and collapsed them onto one row.
 *
 * Stated once so the crawl's writes and the reconciliation's held-lookup
 * cannot key the same variant differently: a second copy would let the loop
 * read stored decisions as missing and re-fetch them forever. `undefined` is
 * the CELEX no store can hold, which is keyed on the docket instead and is
 * therefore not an identity a walk may hunt.
 */
export const ecjSourceDocumentId = (
  celex: string,
  language: string,
): string | undefined => {
  if (!isValidCelex(celex)) {
    return undefined;
  }
  const identity = `${celex}:${language}`;
  return isPersistableSourceDocumentId(identity) ? identity : undefined;
};

/** The identity the ingest would store for one listed variant. */
export const ecjListingIdentity = ({
  celex,
  language,
}: EcjCelexVariant): ListingIdentity => {
  const sourceDocumentId = ecjSourceDocumentId(celex, ecjRowLanguage(language));
  return sourceDocumentId === undefined
    ? { type: "unidentifiable" }
    : { type: "document", sourceDocumentId };
};

/**
 * The distinct (CELEX, language) variants a set of bindings names.
 *
 * A work can expose several XHTML manifestations of one language
 * (re-publications), and bindings for a language this adapter does not
 * publish are dropped exactly as the crawl drops them.
 */
const distinctVariants = (
  bindings: readonly SparqlResult[],
): EcjCelexVariant[] => {
  const variants: EcjCelexVariant[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const language = toEcjLanguage(binding.language.value);
    if (language === undefined) {
      continue;
    }
    const key = `${binding.celex.value}:${language}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    variants.push({ celex: binding.celex.value, language });
  }
  return variants;
};

// -- Fulltext --

/**
 * Fetch one language's XHTML manifestation from a validated Cellar
 * content stream. Returns the verbatim document, or undefined when the
 * translation is unavailable or the request fails.
 *
 * Both undefined cases reach the caller as "the publisher does not serve
 * this variant", which the reconciliation loop eventually retires, so each
 * one is logged: an unserved variant and a failed request are the same
 * value here and must not be the same event.
 */
type FetchManifestationOptions = {
  contentUrl: string;
  celex: string;
  lang: EcjLanguage;
  signal: AbortSignal;
};

/** Shortest plausible decision; below this the response is not a document. */
const MIN_DOCUMENT_LENGTH = 100;

/**
 * What the manifestation URL is asked for, and the only thing accepted back.
 *
 * Unnegotiated, the manifestation resource answers its own RDF description,
 * which is long enough to pass the length check and would be stored as the
 * decision's text. The response is therefore held to the format asked for
 * rather than to its size.
 */
const XHTML_MEDIA_TYPE = "application/xhtml+xml";
const DOCUMENT_MEDIA_TYPES = [XHTML_MEDIA_TYPE, "text/html"] as const;

/**
 * How many of a manifestation's items to try once negotiation has failed.
 *
 * Cellar addresses a manifestation two ways and neither covers the corpus on
 * its own, so the document is looked for under both. Negotiating on the
 * manifestation redirects to the right item for works Cellar stores that way;
 * for the rest that URL answers 404 whatever is asked for, and the document is
 * only reachable as a numbered item under it. The item ordinal is not fixed
 * either — `DOC_1` is the manifestation's first item, not necessarily its
 * document — so the items are tried in order rather than guessed at.
 *
 * Two is enough for every manifestation observed; the third is margin. The
 * walk only runs when negotiation has already failed, so the modern corpus
 * still costs one request.
 */
const MAX_MANIFESTATION_ITEMS = 3;

/**
 * Budget for acquiring one variant, across every address tried.
 *
 * Derived rather than chosen: the lookup makes at most one negotiated request
 * plus one per item, each already bounded by `ADAPTER_TIMEOUT.REQUEST`. Bounding
 * the whole lookup by a single request's budget instead would abort the walk
 * partway and drop a document Cellar serves, which is the failure this fallback
 * exists to prevent.
 */
const MANIFESTATION_LOOKUP_TIMEOUT =
  ADAPTER_TIMEOUT.REQUEST * (MAX_MANIFESTATION_ITEMS + 1);

/**
 * The media type a `Content-Type` names, without its parameters.
 *
 * Compared whole and case-insensitively rather than searched for. A parameter
 * can carry an allowed type into a header that names something else
 * (`application/rdf+xml; profile="text/html"`), which is the one response this
 * check exists to refuse; and the grammar lets a publisher spell the type
 * `Application/XHTML+XML`, which a substring test would reject and this
 * adapter would then retire as unavailable. `pl-courts.ts` keys its listing
 * answers by the same rule; worth extracting to the shared adapter utils once
 * a third caller needs it.
 */
const mediaTypeOf = (contentType: string): string =>
  (contentType.split(";").at(0) ?? "").trim().toLowerCase();

/**
 * Statuses that say this address cannot serve this representation, and so are
 * the only ones worth spending the next address on.
 *
 * Any other failure — throttling, a gateway error, a timeout — says nothing
 * about the address. Walking on would ask a publisher already refusing load
 * for the same document three more times, and would then report as
 * permanently unserved a variant that was merely unreachable, which is the
 * conflation this adapter exists to avoid.
 */
const ADDRESS_EXHAUSTED_STATUSES = [404, 406, 410, 415] as const;

type ManifestationRead =
  | { type: "document"; html: string }
  | { type: "address-exhausted"; status: number }
  | { type: "fetch-failed"; status: number };

type ReadDocumentOptions = {
  url: string;
  /**
   * `undefined` for an item URL, rather than the document types. Cellar serves
   * an older item as `text/html;type=simplified` and matches an `Accept`
   * against that whole type, so naming `text/html` answers 406 on exactly the
   * documents the item walk exists to reach.
   */
  accept: string | undefined;
  celex: string;
  lang: EcjLanguage;
  signal: AbortSignal;
};

/**
 * Read one candidate address, yielding the document only when the response is
 * one. An unusable answer is not reportable on its own: only the caller knows
 * whether another address is left to try.
 */
const readDocumentResponse = async ({
  url,
  accept,
  celex,
  lang,
  signal,
}: ReadDocumentOptions): Promise<ManifestationRead> => {
  const response = await fetchWithTimeout(url, {
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    headers: {
      "User-Agent": INGESTION_USER_AGENT,
      ...(accept === undefined ? {} : { Accept: accept }),
    },
  });

  if (!response.ok) {
    return ADDRESS_EXHAUSTED_STATUSES.some(
      (status) => status === response.status,
    )
      ? { type: "address-exhausted", status: response.status }
      : { type: "fetch-failed", status: response.status };
  }

  const mediaType = mediaTypeOf(response.headers.get("content-type") ?? "");
  if (!DOCUMENT_MEDIA_TYPES.some((type) => type === mediaType)) {
    logger.warn("case_law.ingestion.manifestation_not_a_document", {
      adapterKey: ADAPTER_KEYS.EU_ECJ,
      celex,
      language: lang,
      mediaType,
      url,
    });
    return { type: "address-exhausted", status: response.status };
  }

  const html = await response.text();
  return html.length > MIN_DOCUMENT_LENGTH
    ? { type: "document", html }
    : { type: "address-exhausted", status: response.status };
};

type ManifestationAddress = { url: string; accept: string | undefined };

/**
 * The document and the address that actually served it, which is not always
 * the one the manifestation is named by: an item-only manifestation answers
 * 404 at its own URL, so persisting that as the decision's `documentUrl`
 * would publish a dead link.
 */
type ManifestationDocument = { html: string; url: string };

type ManifestationLookup =
  | ({ type: "document" } & ManifestationDocument)
  | { type: "exhausted"; statuses: number[] }
  | { type: "failed"; status: number };

type ReadFirstServedOptions = {
  addresses: ManifestationAddress[];
  /** Refused statuses so far, in address order; appended to as they come. */
  statuses: number[];
  celex: string;
  lang: EcjLanguage;
  signal: AbortSignal;
};

/**
 * Try each address in turn, yielding the first that serves a document.
 *
 * Recursive rather than a loop because the addresses must be tried in order
 * and stopped at: awaiting them together would ask Cellar for every address
 * of every variant, several times the requests for the fleet's most expensive
 * source, to discard all but one answer.
 */
const readFirstServedAddress = async ({
  addresses,
  statuses,
  celex,
  lang,
  signal,
}: ReadFirstServedOptions): Promise<ManifestationLookup> => {
  const [address, ...rest] = addresses;
  if (address === undefined) {
    return { type: "exhausted", statuses };
  }

  const read = await readDocumentResponse({
    url: address.url,
    accept: address.accept,
    celex,
    lang,
    signal,
  });
  if (read.type === "document") {
    return { type: "document", html: read.html, url: address.url };
  }
  if (read.type === "fetch-failed") {
    return { type: "failed", status: read.status };
  }

  statuses.push(read.status);
  return readFirstServedAddress({
    addresses: rest,
    statuses,
    celex,
    lang,
    signal,
  });
};

const fetchManifestation = async ({
  contentUrl,
  celex,
  lang,
  signal,
}: FetchManifestationOptions): Promise<ManifestationDocument | undefined> => {
  try {
    const lookup = await readFirstServedAddress({
      addresses: [
        { url: contentUrl, accept: XHTML_MEDIA_TYPE },
        ...Array.from(
          { length: MAX_MANIFESTATION_ITEMS },
          (_unused, index): ManifestationAddress => ({
            url: `${contentUrl}/DOC_${index + 1}`,
            accept: undefined,
          }),
        ),
      ],
      statuses: [],
      celex,
      lang,
      signal,
    });

    switch (lookup.type) {
      case "document":
        return { html: lookup.html, url: lookup.url };
      case "failed":
        // Propagate to the caller's retry path instead of reporting missing
        // content or probing another manifestation during a provider outage.
        throw new AdapterFetchError({
          message: `CJEU document request failed: ${lookup.status}`,
          adapterKey: ADAPTER_KEYS.EU_ECJ,
          cursor: null,
          httpStatus: lookup.status,
        });
      case "exhausted":
        // A variant the listing named and no address on the content stream
        // serves is reported unavailable, and the reconciliation loop retires
        // it after its retry schedule. The statuses say which of the two
        // addressing schemes refused it.
        logger.warn("case_law.ingestion.manifestation_unavailable", {
          adapterKey: ADAPTER_KEYS.EU_ECJ,
          celex,
          language: lang,
          httpStatuses: lookup.statuses.join(","),
          url: contentUrl,
        });
        return undefined;
      default: {
        const exhaustive: never = lookup;
        return exhaustive;
      }
    }
  } catch (error) {
    // AbortErrors are expected (timeout, page cancellation)
    if (!(error instanceof DOMException)) {
      captureError(
        new TelemetryError({
          message: `[eu-ecj] manifestation fetch failed for ${celex}/${lang}`,
          cause: error,
        }),
      );
    }
    throw error;
  }
};

/**
 * Parse a manifestation into an AST, sections and fulltext.
 *
 * A parse failure must not lose the decision: the raw XHTML is stored
 * either way, so fall back to stripped text and an empty AST and let
 * the guard tests and the validator surface the regression.
 */
type ParsedManifestation = {
  documentAst: DocumentAst | EmptyAst;
  sections: DecisionSection[] | undefined;
  fulltext: string | undefined;
  keywords: string[];
};

const parseManifestation = (
  input: ParseEcjDecisionInput,
): ParsedManifestation => {
  try {
    const parsed = parseEcjDecisionHtml(input);
    // A parse that lost source text is worse than no parse: the reader
    // renders the AST, so the missing paragraphs would be invisible.
    // Fall through to the stripped-text fallback, which keeps
    // everything, and let the ERROR the validator already logged say
    // which decision needs the parser fixed.
    const lostContent = parsed.validationIssues.some(
      (code) => code === "CONTENT_LOSS" || code === "MISSING_WORDS",
    );
    if (parsed.documentAst.blocks.length > 0 && !lostContent) {
      return {
        documentAst: parsed.documentAst,
        sections: sectionsFromAst(parsed.documentAst.blocks),
        fulltext: parsed.fulltext,
        keywords: parsed.keywords,
      };
    }
  } catch (error) {
    captureError(
      new TelemetryError({
        message: `[eu-ecj] parse failed for ${input.celex}`,
        cause: error,
      }),
    );
  }

  // Bounded to the decision, as a parse would have been: a page that
  // carries the decision also carries its own navigation and footer,
  // and neither belongs in a decision's stored text.
  const text = stripHtml(ecjDocumentHtml(input.html)).trim();
  return {
    documentAst: EMPTY_AST,
    sections: undefined,
    fulltext: text.length > MIN_DOCUMENT_LENGTH ? text : undefined,
    keywords: [],
  };
};

/** Crawl delay between decisions (not between language variants). */
const CRAWL_DELAY_MS = 500;

/** First year the Court sat; the oldest decisions Cellar can list. */
const COURT_EPOCH_YEAR = "1952";

/** First day the Court sat; the widest range a CELEX lookup can need. */
const COURT_EPOCH = `${COURT_EPOCH_YEAR}-01-01`;

type FetchDecisionsByCelexOptions = {
  celexNumbers: readonly string[];
  /** Restrict to these languages; all published languages when omitted. */
  languages?: readonly EcjLanguage[];
  signal: AbortSignal;
};

/**
 * Ingest named decisions by CELEX number, through the adapter's own
 * query and build path.
 *
 * The crawl reaches a decision by walking to its publication date,
 * which is the wrong shape for recording fixtures or backfilling a
 * specific case. This takes the same bindings the crawl would have
 * seen and runs them through the same `buildDecision`.
 */
export const fetchDecisionsByCelex = async ({
  celexNumbers,
  languages,
  signal,
}: FetchDecisionsByCelexOptions): Promise<IngestionResult[]> => {
  // An empty filter emits no FILTER clause, which would turn a lookup
  // for named decisions into an unbounded sweep of the whole corpus.
  if (celexNumbers.length === 0) {
    return [];
  }

  const bindings = await queryDecisions({
    dateFrom: COURT_EPOCH,
    dateTo: toIsoDate(new Date()),
    celexFilter: celexNumbers,
    timeoutMs: ECJ_LISTING_TIMEOUT_MS,
    truncation: SPARQL_TRUNCATION.REFUSE,
    signal,
  });

  const decisions: IngestionResult[] = [];
  const completedVariants = new Set<string>();
  for (const binding of bindings) {
    const lang = toEcjLanguage(binding.language.value);
    if (lang === undefined || (languages && !languages.includes(lang))) {
      continue;
    }
    // A work can expose several XHTML manifestations of one language
    // (re-publications), and a variant is done only once one of them has
    // built — the rule the crawl walks by. Marking it on sight instead
    // would let an unreadable first manifestation stand for the variant
    // while a later usable one goes unvisited, and every caller here reads
    // an empty result as the publisher not serving the document at all.
    const variantKey = `${binding.celex.value}:${lang}`;
    if (completedVariants.has(variantKey)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- rate-limited external calls stay sequential instead of fanning out across every manifestation
    const decision = await buildDecision(binding, signal);
    if (!decision) {
      continue;
    }
    decisions.push(decision);
    completedVariants.add(variantKey);
  }
  return decisions;
};

type ListCelexVariantsOptions = {
  celexNumbers: readonly string[];
  signal: AbortSignal;
};

/**
 * List which language variants Cellar holds as XHTML for the given CELEX
 * numbers, without fetching any manifestation body.
 *
 * A stored variant absent from this listing was never published as XHTML:
 * the census separating re-fetchable rows from phantom ones keys on exactly
 * that. Same query, filters and language mapping as the crawl, so the
 * listing cannot disagree with what a re-fetch would visit.
 */
export const listCelexVariants = async ({
  celexNumbers,
  signal,
}: ListCelexVariantsOptions): Promise<EcjCelexVariant[]> => {
  if (celexNumbers.length === 0) {
    return [];
  }
  return distinctVariants(
    await queryDecisions({
      dateFrom: COURT_EPOCH,
      dateTo: toIsoDate(new Date()),
      celexFilter: celexNumbers,
      timeoutMs: ECJ_LISTING_TIMEOUT_MS,
      truncation: SPARQL_TRUNCATION.REFUSE,
      signal,
    }),
  );
};

/** Historical media type whose string payload passed through normalization. */
const ECJ_RAW_CONTENT_TYPE = "application/xhtml+xml";

/** Media type marking raw bytes that bypassed string normalization. */
const ECJ_VERBATIM_RAW_CONTENT_TYPE =
  "application/xhtml+xml; stella-storage=verbatim";

/** Decision type recorded when the CDM class maps to none of the known ones. */
const UNKNOWN_DECISION_TYPE = "unknown";

/**
 * Fields identifying one language variant of one decision, as either the
 * SPARQL binding or the stored row supplies them.
 */
type EcjDecisionIdentity = {
  celex: string;
  ecli: string;
  court: string;
  decisionDate: string;
  decisionType: string;
  /** Lower-case language tag, as stored on the row. */
  language: string;
  sourceUrl: string | undefined;
  documentUrl: string | undefined;
};

type EcjDecisionFromHtmlOptions = EcjDecisionIdentity & {
  html: string;
  /**
   * Metadata this result carries besides the parser-derived keywords. The
   * crawl passes what the SPARQL binding resolved; a re-parse passes the
   * row's stored metadata, so fields the query once recorded survive.
   */
  metadata: Record<string, unknown>;
};

/**
 * Build the ingestion result for one XHTML manifestation.
 *
 * The crawl and the stored-payload re-parse both go through here, so the
 * two cannot produce different results for the same bytes: replaying a
 * stored payload writes exactly what a fresh crawl of it would write.
 */
const ecjDecisionFromHtml = ({
  celex,
  ecli,
  court,
  decisionDate,
  decisionType,
  language,
  sourceUrl,
  documentUrl,
  html,
  metadata,
}: EcjDecisionFromHtmlOptions): IngestionResult | undefined => {
  const caseNumber = celexToCaseNumber(celex);
  const { documentAst, sections, fulltext, keywords } = parseManifestation({
    caseNumber,
    ecli,
    court,
    decisionDate,
    decisionType,
    sourceUrl,
    language,
    celex,
    html,
  });

  if (!fulltext) {
    return undefined;
  }

  return {
    caseNumber,
    sourceDocumentId: ecjSourceDocumentId(celex, language),
    // What every row this adapter wrote before it stated an id was stored
    // under: one row per docket and language, carrying the EUR-Lex URL of
    // whichever of the docket's documents was written last. That URL names one
    // CELEX in one language exactly, so it re-keys that row to the document it
    // was built from rather than inserting a second one beside it; the
    // docket's other documents find no null-id row and are inserted, which is
    // the collapse being undone.
    ...(sourceUrl === undefined ? {} : { legacySourceUrls: [sourceUrl] }),
    ecli,
    court,
    country: "EU",
    language,
    decisionDate,
    decisionType,
    fulltext,
    sourceUrl,
    documentUrl,
    metadata: {
      ...metadata,
      celex,
      ecli,
      decisionDate,
      decisionType,
      keywords,
    },
    rawHash: hashContent(
      `${celex}|${ecli}|${decisionDate}|${language}|${fulltext}`,
    ),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
    documentAst,
    sections,
    sourceRaw: html,
    sourceRawBytes: new TextEncoder().encode(html),
    sourceRawContentType: ECJ_VERBATIM_RAW_CONTENT_TYPE,
  };
};

/**
 * Media types a stored payload may carry for this adapter. `null` is
 * accepted because the only payload this adapter has ever stored is the
 * Cellar XHTML manifestation, written together with its content type;
 * anything else named is not a manifestation and is rejected rather than
 * fed to the XHTML parser.
 */
const ECJ_REPARSABLE_CONTENT_TYPES = new Set([
  ECJ_RAW_CONTENT_TYPE,
  ECJ_VERBATIM_RAW_CONTENT_TYPE,
  "text/html",
]);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Rebuild the ingestion result for a stored manifestation.
 *
 * The row carries everything the SPARQL query once resolved: CELEX, ECLI,
 * date and type on the row or in its metadata. What the parser derives from
 * the payload (AST, sections, fulltext, keywords) is recomputed; what the
 * query resolved is carried over, so a re-parse cannot invent metadata the
 * publisher never sent.
 */
const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  if (
    stored.contentType !== null &&
    !ECJ_REPARSABLE_CONTENT_TYPES.has(stored.contentType)
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: `stored content type ${stored.contentType}`,
    };
  }

  // CELEX, ECLI and the decision date are the result's identity and feed its
  // hash; a row missing any of them cannot be replayed into the same result
  // the crawl produced, so it is reported instead of guessed at.
  const celex = nonEmptyString(stored.metadata["celex"]);
  const ecli = stored.ecli ?? nonEmptyString(stored.metadata["ecli"]);
  const decisionDate =
    stored.decisionDate ?? nonEmptyString(stored.metadata["decisionDate"]);
  const missing = [
    celex === undefined ? "celex" : undefined,
    ecli === undefined ? "ecli" : undefined,
    decisionDate === undefined ? "decisionDate" : undefined,
  ].filter((field) => field !== undefined);
  if (celex === undefined || ecli === undefined || decisionDate === undefined) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: `missing ${missing.join(", ")}`,
    };
  }

  const language = stored.language.toLowerCase();
  const publishedLanguage = ECJ_LANGUAGES.find(
    (supported) => supported === language.toUpperCase(),
  );
  const html = new TextDecoder().decode(stored.raw);
  if (
    stored.contentType !== ECJ_VERBATIM_RAW_CONTENT_TYPE &&
    ecjKeywordSpacingNeedsVerbatim(html)
  ) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.RAW_FIDELITY_LOST,
      detail:
        "historical source normalization made ECJ keyword spacing ambiguous",
    };
  }
  const result = ecjDecisionFromHtml({
    celex,
    ecli,
    court: stored.court,
    decisionDate,
    decisionType:
      stored.decisionType ??
      nonEmptyString(stored.metadata["decisionType"]) ??
      UNKNOWN_DECISION_TYPE,
    language,
    sourceUrl:
      stored.sourceUrl ??
      (publishedLanguage && eurLexSourceUrl(publishedLanguage, celex)),
    documentUrl: stored.documentUrl ?? undefined,
    html,
    metadata: stored.metadata,
  });

  return result === undefined
    ? {
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
        detail: `no fulltext parsed from the stored payload for ${celex}`,
      }
    : { type: "parsed", result };
};

/**
 * Turn one SPARQL binding into an ingestion result: fetch the language
 * variant's XHTML manifestation, parse it, and attach the metadata the
 * query already resolved.
 *
 * Exported so fixture recording goes through the same path the crawl
 * does; a fixture that drifts from adapter output is worse than none.
 */
export const buildDecision = async (
  binding: SparqlResult,
  signal: AbortSignal,
): Promise<IngestionResult | undefined> => {
  const celex = binding.celex.value;
  const ecli = binding.ecli.value;
  const date = binding.date.value;
  const decisionType =
    CDM_TYPE_MAP[binding.type.value] ?? UNKNOWN_DECISION_TYPE;
  const lang = toEcjLanguage(binding.language.value);
  const documentUrl = toCellarContentUrl(binding.manifestation.value);

  if (!lang || !documentUrl) {
    return undefined;
  }

  const court = ecli.includes(":T:") ? "General Court" : "Court of Justice";

  // Fetch the language-specific XHTML stream from Cellar. The
  // human-facing EUR-Lex HTML endpoint is WAF-protected and may return
  // a challenge instead of document content to server-side callers.
  const served = await fetchManifestation({
    contentUrl: documentUrl,
    celex,
    lang,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(MANIFESTATION_LOOKUP_TIMEOUT),
    ]),
  });

  if (!served) {
    return undefined;
  }

  return ecjDecisionFromHtml({
    celex,
    ecli,
    court,
    decisionDate: date,
    decisionType,
    language: ecjRowLanguage(lang),
    sourceUrl: eurLexSourceUrl(lang, celex),
    // The address that answered, not the one the manifestation is named by:
    // an item-only manifestation answers 404 at its own URL.
    documentUrl: served.url,
    html: served.html,
    metadata: {
      manifestationUri: binding.manifestation.value,
      languageUri: binding.language.value,
      cdmType: binding.type.value,
    },
  });
};

// -- Date helpers --

const toIsoDate = (d: Date): string =>
  d.toISOString().split("T")[0] ?? "1970-01-01";

const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
};

// -- Reconciliation --
//
// A slice for this source is one decision year. The listing surface is
// addressed by decision date, so a year is a range the publisher can be asked
// about directly, and `YYYY` sorts lexicographically in chronological order —
// the ordering the ledger relies on. A day would be the finer unit, as it is
// for the crawl, but the Court sits on a few hundred days a year: a day-sliced
// sweep would spend most of its units proving that nothing was decided, and
// would need about twenty-five thousand of them to reach the Court's first
// decisions.

const ECJ_SLICE_YEAR = /^\d{4}$/u;

/**
 * A year is listed one calendar month at a time.
 *
 * The cap on a SPARQL response is `SPARQL_LIMIT` bindings and a busy month
 * measures around 1,500 of them, so a whole year in one query would sit close
 * to the cap and a truncated listing is refused rather than banked. Twelve
 * fixed pages also make the page number an offset nothing has to remember:
 * every page is derived from the slice alone, so a re-walk asks the same
 * questions in the same order.
 */
const ECJ_SLICE_PAGES = 12;

/**
 * Tip slices re-walked on the loop's fast cadence. `tipWindowDays` counts
 * slices, not days, so with year slices this is the current year and the one
 * before it.
 *
 * The window is what catches a slice the publisher adds to after it was first
 * walked, and this publisher adds translations to a decision for a long time
 * after the judgment date that files it under a year. Two slices give a
 * decision between twelve and twenty-four months of tip coverage, depending on
 * where in its year it was decided.
 *
 * And that is the whole of it: a year walked complete and left behind is not
 * listed again. The ledger's backlog only revisits slices already recorded
 * short, and the sweep only fills history never surveyed at all, so a
 * translation arriving after its year leaves the window stays unseen until
 * something re-surveys that year. Closing that means re-walking stale complete
 * slices, which is the loop's selection policy and belongs with it rather than
 * with one adapter's window.
 */
const ECJ_TIP_WINDOW_SLICES = 2;

const ecjYearOf = (date: Date): string =>
  toIsoDate(date).slice(0, COURT_EPOCH_YEAR.length);

const ecjSliceYear = (slice: string): number => {
  if (!ECJ_SLICE_YEAR.test(slice)) {
    panic(`eu-ecj slice is not a four-digit year: ${slice}`);
  }
  return Number.parseInt(slice, 10);
};

/** Fixed width keeps the lexicographic ordering the ledger walks by. */
const ecjSlice = (year: number): string =>
  String(year).padStart(COURT_EPOCH_YEAR.length, "0");

const ecjNextSlice = (slice: string): string | null => {
  const next = ecjSlice(ecjSliceYear(slice) + 1);
  return next > ecjYearOf(new Date()) ? null : next;
};

const ecjPreviousSlice = (slice: string): string | null => {
  const previous = ecjSlice(ecjSliceYear(slice) - 1);
  return previous < COURT_EPOCH_YEAR ? null : previous;
};

type EcjSliceRange = {
  dateFrom: string;
  dateTo: string;
};

/** The calendar month one page of a year slice covers, inclusive. */
const ecjSlicePageRange = (slice: string, page: number): EcjSliceRange => {
  if (!Number.isInteger(page) || page < 0 || page >= ECJ_SLICE_PAGES) {
    panic(`eu-ecj slice page out of range: ${page}`);
  }
  const year = ecjSliceYear(slice);
  const monthIndex = page;
  return {
    dateFrom: toIsoDate(new Date(Date.UTC(year, monthIndex, 1))),
    // Day 0 of the following month is the last day of this one.
    dateTo: toIsoDate(new Date(Date.UTC(year, monthIndex + 1, 0))),
  };
};

/**
 * One page of what the publisher lists for a slice, with no manifestation
 * fetched.
 *
 * The crawl reaches a decision by walking its cursor to the publication date
 * and downloads every language variant it finds there, which is the wrong
 * shape for asking what a year contains. This is the same query, filters and
 * language mapping as the crawl, stopping at the listing, so what it says the
 * year holds cannot disagree with what a crawl of that year would store.
 */
const listEcjSlicePage = async ({
  slice,
  page,
  signal,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const { dateFrom, dateTo } = ecjSlicePageRange(slice, page);
  // A request that times out throws out of here, which halts the unit and
  // leaves the slice's previous ledger row standing. Never a short page: a
  // partial listing banked as the whole slice reads as reconciled.
  const bindings = await queryDecisions({
    dateFrom,
    dateTo,
    timeoutMs: ECJ_LISTING_TIMEOUT_MS,
    truncation: SPARQL_TRUNCATION.REFUSE,
    signal: signal ?? AbortSignal.timeout(ECJ_LISTING_TIMEOUT_MS),
  });
  const variants = distinctVariants(bindings);
  return {
    items: variants.map((variant) => ({
      identity: ecjListingIdentity(variant),
      payload: variant,
    })),
    // Structural, not reported: the publisher answers a date range, so the
    // months of the year are the pages whether or not it decided anything in
    // them.
    totalPages: ECJ_SLICE_PAGES,
  };
};

const isEcjCelexVariant = (value: unknown): value is EcjCelexVariant =>
  isRecord(value) &&
  typeof value["celex"] === "string" &&
  isValidCelex(value["celex"]) &&
  ECJ_LANGUAGES.some((language) => language === value["language"]);

/**
 * Rebuild one listed variant, through the adapter's own query and build path.
 *
 * The payload is the variant, not the binding that named it: a parked item is
 * replayed days later, and a manifestation URI recorded at listing time may
 * by then point at a superseded version. Listing the CELEX again resolves the
 * current manifestation, which is what a crawl reaching that decision today
 * would fetch.
 *
 * A variant Cellar lists but does not serve — no manifestation for the
 * language, or nothing behind the one it names — is reported as unavailable
 * rather than written. It is an ordinary outcome, not a failure: the loop
 * parks such an item, widens its schedule and eventually retires it, and a
 * retired item is what lets its slice settle. Writing a detail-less row
 * instead would make the identity held and take the document out of every
 * later reconciliation.
 */
const buildEcjVariant = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isEcjCelexVariant(payload)) {
    return { type: "unkeyable" };
  }
  const decisions = await fetchDecisionsByCelex({
    celexNumbers: [payload.celex],
    languages: [payload.language],
    signal: signal ?? AbortSignal.timeout(ECJ_LISTING_TIMEOUT_MS),
  });
  const decision = decisions.at(0);
  return decision === undefined
    ? { type: "detail-unavailable" }
    : { type: "built", decision };
};

// -- Adapter --

/**
 * Per-page timeout for ECJ. Higher than the default
 * PAGE timeout because we fetch up to 24 language
 * variants per decision (24 × ~15 decisions × 500ms).
 */
const ECJ_PAGE_TIMEOUT = 300_000;

export const euEcjAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.EU_ECJ,
  name: "Court of Justice of the European Union",
  country: "EU",
  language: "en",
  minRequestIntervalMs: 1000,
  pageTimeoutMs: ECJ_PAGE_TIMEOUT,
  // One stored payload is one language variant of one decision, so a stored
  // manifestation maps back to exactly the row it was stored for.
  reparseStoredRaw,

  /**
   * The publisher lists a date range independently of the crawl cursor, so
   * what a year contains is answerable without re-crawling it: enumerate the
   * year, key each variant the way the ingest would, and compare against what
   * is held.
   */
  reconciliation: {
    firstSlice: COURT_EPOCH_YEAR,
    sliceOf: ecjYearOf,
    nextSlice: ecjNextSlice,
    previousSlice: ecjPreviousSlice,
    tipWindowDays: ECJ_TIP_WINDOW_SLICES,
    listSlicePage: listEcjSlicePage,
    buildDecision: buildEcjVariant,
  },

  /**
   * Counts (work, language) pairs under the same type and manifestation
   * filters the page query uses, so the total is the exact universe this
   * crawl can ever ingest — not Cellar's whole case-law class, which
   * includes works with no XHTML manifestation that a crawl would never
   * store.
   */
  async getTotalCount(signal) {
    try {
      const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT (COUNT(*) AS ?n)
WHERE {
  SELECT DISTINCT ?doc ?language
  WHERE {
    ?doc cdm:case-law_ecli ?ecli .
    ?doc a ?type .
    ?expression cdm:expression_belongs_to_work ?doc .
    ?expression cdm:expression_uses_language ?language .
    ?manifestation cdm:manifestation_manifests_expression ?expression .
    ?manifestation cdm:manifestation_type ?manifestationType .
    FILTER(?type IN (
      cdm:judgement,
      cdm:order,
      cdm:order_cjeu,
      cdm:opinion_advocate_general,
      cdm:opinion_advocate-general
    ))
    FILTER(STR(?manifestationType) = "xhtml")
  }
}`.trim();
      const response = await fetchWithTimeout(SPARQL_URL, {
        method: "POST",
        signal,
        timeoutMs: 60_000,
        headers: {
          Accept: "application/sparql-results+json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": INGESTION_USER_AGENT,
        },
        body: new URLSearchParams({ query }).toString(),
      });
      if (!response.ok) {
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
      }
      const json: unknown = await response.json();
      if (!isRecord(json)) {
        return sourceTotalProbeFailed(
          SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
        );
      }
      const results = json["results"];
      if (!isRecord(results) || !Array.isArray(results["bindings"])) {
        return sourceTotalProbeFailed(
          SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
        );
      }
      const binding: unknown = results["bindings"].at(0);
      if (!isRecord(binding) || !isRecord(binding["n"])) {
        return sourceTotalProbeFailed(
          SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
        );
      }
      return sourceTotalRead(
        Number.parseInt(String(binding["n"]["value"]), 10),
      );
    } catch (error) {
      return { type: "probe-failed", errorTag: errorTag(error) };
    }
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const abortSignal = signal ?? AbortSignal.timeout(ECJ_PAGE_TIMEOUT);

        // Cursor is a date; each page = 1 day.
        // Null cursor defaults to 7 days ago (used by health
        // checks). Historical backfill is triggered by setting
        // the DB cursor to "1952-01-01" after deploy.
        const dateFrom = cursor ?? addDays(toIsoDate(new Date()), -7);
        const dateTo = dateFrom;

        // 1. Query SPARQL for decisions on this date
        const bindings = await queryDecisions({
          dateFrom,
          dateTo,
          // A live crawl fails fast and moves on; only the bulk listings buy
          // headroom, because they have no cursor to come back to.
          timeoutMs: ADAPTER_TIMEOUT.REQUEST,
          truncation: SPARQL_TRUNCATION.WARN,
          signal: abortSignal,
        });

        const decisions: IngestionResult[] = [];
        const completedVariants = new Set<string>();
        let previousCelex: string | undefined;

        // 2. Fetch and parse each language variant
        for (const binding of bindings) {
          if (abortSignal.aborted) {
            break;
          }

          const celex = binding.celex.value;
          const variantKey = `${celex}:${binding.language.value}`;
          if (completedVariants.has(variantKey)) {
            continue;
          }

          if (previousCelex !== undefined && previousCelex !== celex) {
            // oxlint-disable-next-line no-await-in-loop -- deliberate crawl delay between decisions; language variants within one decision remain contiguous and unslept
            await Bun.sleep(CRAWL_DELAY_MS);
          }
          previousCelex = celex;

          // oxlint-disable-next-line no-await-in-loop -- rate-limited external calls stay sequential instead of fanning out across every language manifestation
          const decision = await buildDecision(binding, abortSignal);
          if (!decision) {
            continue;
          }

          decisions.push(decision);
          completedVariants.add(variantKey);
        }

        // If the page was aborted mid-iteration, retry
        // the same day on the next run instead of skipping it.
        if (abortSignal.aborted) {
          return { decisions, nextCursor: dateFrom };
        }

        // Advance cursor to next day; stop if
        // we've reached today
        const nextDate = addDays(dateFrom, 1);
        const today = toIsoDate(new Date());
        // Park at today when exhausted; never null (null
        // triggers a health-check-friendly recent window, not
        // a full historical re-scan).
        const nextCursor = nextDate <= today ? nextDate : today;

        return { decisions, nextCursor };
      },
      catch: adapterCatch(ADAPTER_KEYS.EU_ECJ, cursor),
    });
  },
});
