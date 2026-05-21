import { Result } from "better-result";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSION,
} from "@/api/handlers/case-law/consts";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { captureError } from "@/api/lib/analytics";
import {
  AdapterFetchError,
  TelemetryError,
} from "@/api/lib/errors/tagged-errors";
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
 * 2. For each decision, fetch fulltext from EUR-Lex HTML.
 *
 * Cursor format: ISO date string (YYYY-MM-DD). Each page
 * covers one day; null cursor starts 7 days ago.
 *
 * The SPARQL endpoint returns structured metadata (ECLI,
 * date, CELEX, decision type) directly — no HTML scraping
 * needed for the list.
 */

const SPARQL_URL = "https://publications.europa.eu/webapi/rdf/sparql";

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

const eurLexHtmlUrl = (lang: EcjLanguage, celex: string) =>
  `https://eur-lex.europa.eu/legal-content/${lang}` +
  `/TXT/HTML/?uri=CELEX:${celex}`;

const eurLexSourceUrl = (lang: EcjLanguage, celex: string) =>
  `https://eur-lex.europa.eu/legal-content/${lang}` +
  `/ALL/?uri=CELEX:${celex}`;

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
  isSparqlBinding(value["type"]);

const isSparqlResponse = (value: unknown): value is SparqlResponse =>
  isRecord(value) &&
  isRecord(value["results"]) &&
  Array.isArray(value["results"]["bindings"]) &&
  value["results"]["bindings"].every(isSparqlResult);

const SPARQL_LIMIT = 10_000;

const CDM_TYPE_MAP: Record<string, string> = {
  "http://publications.europa.eu/ontology/cdm#judgement": "judgment",
  "http://publications.europa.eu/ontology/cdm#order": "order",
  "http://publications.europa.eu/ontology/cdm#opinion_advocate_general":
    "opinion",
};

/**
 * Query the Cellar SPARQL endpoint for CJEU decisions
 * within a date range.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const queryDecisions = async (
  dateFrom: string,
  dateTo: string,
  signal: AbortSignal,
): Promise<SparqlResult[]> => {
  if (!ISO_DATE.test(dateFrom) || !ISO_DATE.test(dateTo)) {
    throw new AdapterFetchError({
      message: `Invalid date format: ${dateFrom} / ${dateTo}`,
      adapterKey: ADAPTER_KEYS.EU_ECJ,
      cursor: dateFrom,
    });
  }

  const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?ecli ?date ?celex ?type
WHERE {
  ?doc cdm:case-law_ecli ?ecli .
  ?doc cdm:work_date_document ?date .
  ?doc cdm:resource_legal_id_celex ?celex .
  ?doc a ?type .
  FILTER(?type IN (
    cdm:judgement,
    cdm:order,
    cdm:opinion_advocate_general
  ))
  FILTER(STR(?date) >= "${dateFrom}")
  FILTER(STR(?date) <= "${dateTo}")
}
ORDER BY ASC(?date) ASC(?celex)
LIMIT ${SPARQL_LIMIT}`.trim();

  const response = await fetch(SPARQL_URL, {
    method: "POST",
    signal,
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
    // eslint-disable-next-line no-console -- adapter diagnostic
    console.warn(
      `[eu-ecj] SPARQL response hit LIMIT ${SPARQL_LIMIT}` +
        ` for date ${dateFrom}; some decisions may be missing`,
    );
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
  const match = /^6(\d{4})(CJ|TJ|CC|CO|TO|FJ)(\d+)/u.exec(celex);
  if (!match) {
    return celex;
  }

  const yearStr = match[1];
  const typeStr = match[2];
  const numStr = match[3];
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
 * Fetch fulltext from EUR-Lex HTML endpoint.
 * Returns stripped text or undefined on failure.
 */
const fetchFulltext = async (
  celex: string,
  lang: EcjLanguage,
  signal: AbortSignal,
): Promise<string | undefined> => {
  try {
    const response = await fetch(eurLexHtmlUrl(lang, celex), {
      signal,
      headers: { "User-Agent": INGESTION_USER_AGENT },
    });

    if (!response.ok) {
      return undefined;
    }

    const html = await response.text();

    // Extract the main content div. Greedy match captures
    // everything up to the outermost </div> before <!--,
    // avoiding early termination on inner div comments.
    const bodyMatch =
      /<div[^>]*id="TexteOnly"[^>]*>([\s\S]*)<\/div>\s*<!--/iu.exec(html);
    if (!bodyMatch) {
      // Fallback: extract <body> content
      const fallback = /<body[^>]*>([\s\S]*)<\/body>/iu.exec(html);
      if (!fallback?.[1]) {
        return undefined;
      }
      const text = stripHtml(fallback[1])
        // eslint-disable-next-line no-control-regex -- strip control chars for PG
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/gu, "")
        .trim();
      return text.length > 100 ? text : undefined;
    }

    const text = stripHtml(bodyMatch[1] ?? "")
      // eslint-disable-next-line no-control-regex -- strip control chars for PG
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/gu, "")
      .trim();
    return text.length > 100 ? text : undefined;
  } catch (error) {
    // AbortErrors are expected (timeout, page cancellation)
    if (!(error instanceof DOMException)) {
      captureError(
        new TelemetryError({
          message: `[eu-ecj] fulltext fetch failed for ${celex}/${lang}`,
          cause: error,
        }),
      );
    }
    return undefined;
  }
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
        const dateFrom =
          cursor ?? toIsoDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
        const dateTo = dateFrom;

        // 1. Query SPARQL for decisions on this date
        const bindings = await queryDecisions(dateFrom, dateTo, abortSignal);

        const decisions: IngestionResult[] = [];

        // 2. Process each SPARQL result
        for (const binding of bindings) {
          const celex = binding.celex.value;
          const ecli = binding.ecli.value;
          const date = binding.date.value;
          const caseNumber = celexToCaseNumber(celex);
          const decisionType = CDM_TYPE_MAP[binding.type.value] ?? "unknown";

          const court = ecli.includes(":T:")
            ? "General Court"
            : "Court of Justice";

          // 3. Fetch fulltext in each language
          for (const lang of ECJ_LANGUAGES) {
            const fulltext = await fetchFulltext(
              celex,
              lang,
              AbortSignal.any([
                abortSignal,
                AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
              ]),
            );

            // Skip languages where text is unavailable
            if (!fulltext) {
              continue;
            }

            const langLower = lang.toLowerCase();
            const raw = `${celex}|${ecli}|${date}|${langLower}|${fulltext}`;

            decisions.push({
              caseNumber,
              ecli,
              court,
              country: "EU",
              language: langLower,
              decisionDate: date,
              decisionType,
              fulltext,
              sourceUrl: eurLexSourceUrl(lang, celex),
              documentUrl: eurLexHtmlUrl(lang, celex),
              metadata: { celex },
              rawHash: hashContent(raw),
              parserVersion: PARSER_VERSION,
              // TODO: integrate court-specific parser for AST
              documentAst: EMPTY_AST,
              sourceRaw: undefined,
            });
          }

          // Rate-limit per decision (not per language) to
          // keep total sleep within the page timeout budget.
          if (!abortSignal.aborted) {
            await Bun.sleep(500);
          }
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
