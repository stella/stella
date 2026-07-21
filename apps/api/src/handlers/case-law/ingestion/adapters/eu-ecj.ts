import { Result } from "better-result";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSION,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import type { ParseEcjDecisionInput } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj";
import { parseEcjDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { captureError } from "@/api/lib/analytics/capture";
import {
  AdapterFetchError,
  TelemetryError,
} from "@/api/lib/errors/tagged-errors";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

/**
 * European Court of Justice (CJEU) adapter.
 *
 * Uses the Cellar SPARQL endpoint (no auth) to discover
 * decisions and EUR-Lex HTML for fulltext retrieval.
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
  return `https://publications.europa.eu/resource/cellar/${manifestationId}/DOC_1`;
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

const SPARQL_LIMIT = 10_000;

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

type QueryDecisionsOptions = {
  dateFrom: string;
  dateTo: string;
  signal: AbortSignal;
  /**
   * Restrict the page to these CELEX numbers. Used to record fixtures
   * for named decisions through the same query the crawl runs, instead
   * of crawling a whole publication day to reach them.
   */
  celexFilter?: readonly string[];
};

/** CELEX numbers are alphanumeric with optional bracketed suffixes. */
const CELEX = /^[0-9A-Z()]+$/u;

const queryDecisions = async ({
  dateFrom,
  dateTo,
  signal,
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
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
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

// -- Fulltext --

/**
 * Fetch one language's XHTML manifestation from a validated Cellar
 * content stream. Returns the verbatim document, or undefined when the
 * translation is unavailable or the request fails.
 */
type FetchManifestationOptions = {
  contentUrl: string;
  celex: string;
  lang: EcjLanguage;
  signal: AbortSignal;
};

/** Shortest plausible decision; below this the response is not a document. */
const MIN_DOCUMENT_LENGTH = 100;

const fetchManifestation = async ({
  contentUrl,
  celex,
  lang,
  signal,
}: FetchManifestationOptions): Promise<string | undefined> => {
  try {
    const response = await fetchWithTimeout(contentUrl, {
      signal,
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      headers: { "User-Agent": INGESTION_USER_AGENT },
    });

    if (!response.ok) {
      return undefined;
    }

    const html = await response.text();
    return html.length > MIN_DOCUMENT_LENGTH ? html : undefined;
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
    return undefined;
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
    if (parsed.documentAst.blocks.length > 0) {
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

  const text = stripHtml(input.html).trim();
  return {
    documentAst: EMPTY_AST,
    sections: undefined,
    fulltext: text.length > MIN_DOCUMENT_LENGTH ? text : undefined,
    keywords: [],
  };
};

/** Crawl delay between decisions (not between language variants). */
const CRAWL_DELAY_MS = 500;

/** First day the Court sat; the widest range a CELEX lookup can need. */
const COURT_EPOCH = "1952-01-01";

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
  const bindings = await queryDecisions({
    dateFrom: COURT_EPOCH,
    dateTo: toIsoDate(new Date()),
    celexFilter: celexNumbers,
    signal,
  });

  const decisions: IngestionResult[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const lang = toEcjLanguage(binding.language.value);
    if (lang === undefined || (languages && !languages.includes(lang))) {
      continue;
    }
    // A work can expose several XHTML manifestations of one language
    // (re-publications); the first is the one the crawl would take.
    const variantKey = `${binding.celex.value}:${lang}`;
    if (seen.has(variantKey)) {
      continue;
    }
    seen.add(variantKey);
    // oxlint-disable-next-line no-await-in-loop -- rate-limited external calls stay sequential instead of fanning out across every manifestation
    const decision = await buildDecision(binding, signal);
    if (decision) {
      decisions.push(decision);
    }
  }
  return decisions;
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
  const caseNumber = celexToCaseNumber(celex);
  const decisionType = CDM_TYPE_MAP[binding.type.value] ?? "unknown";
  const lang = toEcjLanguage(binding.language.value);
  const documentUrl = toCellarContentUrl(binding.manifestation.value);

  if (!lang || !documentUrl) {
    return undefined;
  }

  const court = ecli.includes(":T:") ? "General Court" : "Court of Justice";

  // Fetch the language-specific XHTML stream from Cellar. The
  // human-facing EUR-Lex HTML endpoint is WAF-protected and may return
  // a challenge instead of document content to server-side callers.
  const html = await fetchManifestation({
    contentUrl: documentUrl,
    celex,
    lang,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
    ]),
  });

  if (!html) {
    return undefined;
  }

  const sourceUrl = eurLexSourceUrl(lang, celex);
  const { documentAst, sections, fulltext, keywords } = parseManifestation({
    caseNumber,
    ecli,
    court,
    decisionDate: date,
    decisionType,
    sourceUrl,
    celex,
    html,
  });

  if (!fulltext) {
    return undefined;
  }

  const language = lang.toLowerCase();

  return {
    caseNumber,
    ecli,
    court,
    country: "EU",
    language,
    decisionDate: date,
    decisionType,
    fulltext,
    sourceUrl,
    documentUrl,
    metadata: {
      celex,
      ecli,
      decisionDate: date,
      decisionType,
      keywords,
      manifestationUri: binding.manifestation.value,
      languageUri: binding.language.value,
      cdmType: binding.type.value,
    },
    rawHash: hashContent(`${celex}|${ecli}|${date}|${language}|${fulltext}`),
    parserVersion: PARSER_VERSION,
    documentAst,
    sections,
    sourceRaw: html,
    sourceRawContentType: "application/xhtml+xml",
  };
};

// -- Date helpers --

const toIsoDate = (d: Date): string =>
  d.toISOString().split("T")[0] ?? "1970-01-01";

const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
};

// -- Adapter --

/**
 * Per-page timeout for ECJ. Higher than the default
 * PAGE timeout because we fetch up to 24 language
 * variants per decision (24 × ~15 decisions × 500ms).
 */
const ECJ_PAGE_TIMEOUT = 300_000;

export const euEcjAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.EU_ECJ,
  name: "Court of Justice of the European Union",
  country: "EU",
  language: "en",
  minRequestIntervalMs: 1000,
  pageTimeoutMs: ECJ_PAGE_TIMEOUT,

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
};
