import { panic, Result } from "better-result";

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
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
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
import { captureError } from "@/api/lib/analytics";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { sanitizeUrl } from "@/api/lib/sanitize-url";
import { isRecord } from "@/api/lib/type-guards";

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

/**
 * Concurrent finaldoc fetches per page. The court server
 * returns 429 when overloaded (handled with a 2s backoff),
 * so we can safely push higher concurrency and self-correct.
 */
const FINALDOC_CONCURRENCY = 15;
const FINALDOC_BATCH_DELAY_MS = 50;
const LIST_FETCH_RETRIES = 2;
const LIST_FETCH_RETRY_DELAY_MS = 5000;

/**
 * Map English decision type enums from the API to
 * lowercase Czech equivalents for consistency across
 * all CZ adapters.
 */
const DECISION_TYPE_MAP: Record<string, string> = {
  JUDGEMENT: "rozsudek",
  RESOLUTION: "usnesení",
  ORDER: "příkaz",
};

const mapDecisionType = (type: string | undefined): string | undefined => {
  if (!type) {
    return undefined;
  }
  return DECISION_TYPE_MAP[type] ?? type.toLowerCase();
};

/** Shape of a single item in the paginated day response. */
type CzRegionalApiItem = {
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

/** Solver can be a flat string or a structured object (API changed). */
type FinaldocSolver =
  | string
  | {
      titlesBefore?: string;
      firstName?: string;
      lastName?: string;
      titlesAfter?: string;
      function?: string;
    };

/** Response shape from /api/finaldoc/{uuid}. */
type CzRegionalFinaldoc = {
  verdictText?: string | null;
  justificationText?: string | null;
  header?: FinaldocParagraph[] | null;
  verdict?: FinaldocParagraph[] | null;
  justification?: FinaldocParagraph[] | null;
  information?: FinaldocParagraph[] | null;
  styles?: FinaldocStyle[] | null;
  metadata?: {
    type?: string | null;
    solver?: FinaldocSolver | null;
    caseNumber?: unknown;
    caseResultType?: string | string[] | null;
    caseSubject?: string | null;
    regulations?: unknown[] | null;
    flags?: string[] | null;
    [key: string]: unknown;
  } | null;
};

type FinaldocResult = {
  fulltext: string | undefined;
  decisionType: string | undefined;
  documentAst: DocumentAst | EmptyAst;
  sourceRaw: string | undefined;
  richMetadata: {
    decisionTypeRaw?: string;
    solver?: FinaldocSolver;
    caseResultType?: string | string[];
    caseSubject?: string;
    regulations?: unknown[];
    flags?: string[];
  };
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
 * for decision type mapping).
 */
const isCzRegionalMetadata = (
  value: unknown,
): value is NonNullable<CzRegionalFinaldoc["metadata"]> =>
  isRecord(value) && isNullishString(value["type"]);

const isCzRegionalFinaldoc = (value: unknown): value is CzRegionalFinaldoc =>
  isRecord(value) &&
  isNullishString(value["verdictText"]) &&
  isNullishString(value["justificationText"]) &&
  isNullishArrayOf(value["header"], isFinaldocParagraph) &&
  isNullishArrayOf(value["verdict"], isFinaldocParagraph) &&
  isNullishArrayOf(value["justification"], isFinaldocParagraph) &&
  isNullishArrayOf(value["information"], isFinaldocParagraph) &&
  isNullishArrayOf(value["styles"], isFinaldocStyle) &&
  isNullishValue(value["metadata"], isCzRegionalMetadata);

const isCzRegionalApiItem = (value: unknown): value is CzRegionalApiItem =>
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
 * Fetch fulltext from the /api/finaldoc/{uuid} endpoint.
 * Parses the structured JSON into a DocumentAst when possible,
 * falling back to plain text concatenation on parser failure.
 */
const fetchFinaldoc = async (
  docUrl: string,
  item: IngestionResult,
  signal?: AbortSignal,
): Promise<FinaldocResult> => {
  const empty: FinaldocResult = {
    fulltext: undefined,
    decisionType: undefined,
    documentAst: EMPTY_AST,
    sourceRaw: undefined,
    richMetadata: {},
  };

  try {
    const response = await fetchWithRetry(
      docUrl,
      { headers: { Accept: "application/json" } },
      {
        maxRetries: 1,
        signal,
        adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
      },
    );

    if (!response.ok) {
      return empty;
    }

    const doc = await response.json();
    // Always preserve sourceRaw even if validation fails.
    // The raw response can be re-parsed when the validator is fixed.
    const sourceRaw = JSON.stringify(doc);

    if (!isCzRegionalFinaldoc(doc)) {
      captureError(
        new AdapterFetchError({
          message: `CZ Regional finaldoc validation failed for ${item.caseNumber}`,
          adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
          cursor: null,
        }),
        { docUrl, caseNumber: item.caseNumber },
      );

      return {
        fulltext: undefined,
        decisionType: undefined,
        documentAst: EMPTY_AST,
        sourceRaw,
        richMetadata: {},
      };
    }

    const decisionType = mapDecisionType(toOptionalValue(doc.metadata?.type));

    const richMetadata: FinaldocResult["richMetadata"] = {};
    const decisionTypeRaw = toOptionalValue(doc.metadata?.type);
    if (decisionTypeRaw) {
      richMetadata.decisionTypeRaw = decisionTypeRaw;
    }
    const solver = doc.metadata?.solver ?? undefined;
    if (solver !== undefined) {
      richMetadata.solver = solver;
    }
    const caseResultType = doc.metadata?.caseResultType ?? undefined;
    if (caseResultType !== undefined) {
      richMetadata.caseResultType = caseResultType;
    }
    const caseSubject = toOptionalValue(doc.metadata?.caseSubject);
    if (caseSubject) {
      richMetadata.caseSubject = caseSubject;
    }
    if (doc.metadata?.regulations) {
      richMetadata.regulations = doc.metadata.regulations;
    }
    if (doc.metadata?.flags) {
      richMetadata.flags = doc.metadata.flags;
    }

    // Plain text fallback
    const textParts: string[] = [];
    const verdictText = toOptionalValue(doc.verdictText);
    if (verdictText) {
      textParts.push(verdictText);
    }
    const justificationText = toOptionalValue(doc.justificationText);
    if (justificationText) {
      textParts.push(justificationText);
    }
    const plainFulltext =
      textParts.length > 0 ? textParts.join("\n\n") : undefined;

    // Try structured parser
    try {
      const parsed = parseRegionalDecision({
        caseNumber: item.caseNumber,
        ecli: item.ecli,
        court: item.court,
        decisionDate: item.decisionDate,
        decisionType,
        sourceUrl: item.sourceUrl,
        header: doc.header ?? [],
        verdict: doc.verdict ?? [],
        justification: doc.justification ?? [],
        information: doc.information ?? [],
        styles: doc.styles ?? [],
        verdictText: verdictText ?? "",
        justificationText: justificationText ?? "",
      });

      return {
        fulltext: parsed.fulltext || plainFulltext,
        decisionType,
        documentAst: parsed.documentAst,
        sourceRaw,
        richMetadata,
      };
    } catch {
      // Parser failed; fall back to empty AST + plain text
      return {
        fulltext: plainFulltext,
        decisionType,
        documentAst: EMPTY_AST,
        sourceRaw,
        richMetadata,
      };
    }
  } catch {
    return empty;
  }
};

const parseItem = (item: CzRegionalApiItem): IngestionResult | null => {
  if (!item.jednaciCislo || !item.soud) {
    return null;
  }

  const raw = JSON.stringify(item);

  return {
    caseNumber: item.jednaciCislo,
    ecli: toOptionalValue(item.ecli),
    court: item.soud,
    country: "CZE",
    language: "cs",
    decisionDate: toOptionalValue(item.datumVydani),
    sourceUrl: sanitizeUrl(toOptionalValue(item.odkaz) ?? ""),
    documentUrl: sanitizeUrl(toOptionalValue(item.odkaz) ?? ""),
    metadata: {
      caseNumber: item.jednaciCislo,
      ecli: toOptionalValue(item.ecli),
      court: item.soud,
      decisionDate: toOptionalValue(item.datumVydani),
      decisionType: undefined,
      author: toOptionalValue(item.autor),
      subjectOfProceeding: toOptionalValue(item.predmetRizeni),
      publishedDate: toOptionalValue(item.datumZverejneni),
      keywords: item.klicovaSlova,
      mentionedStatutes: item.zminenaUstanoveni,
    },
    rawHash: hashContent(raw),
    parserVersion: PARSER_VERSION,
    // TODO: integrate court-specific parser for AST
    documentAst: EMPTY_AST,
  };
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

/** Build the day endpoint URL from a YYYY-MM-DD date. */
const buildDayUrl = (date: string, page: number): string => {
  const parts = date.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;

  return `${BASE_URL}/opendata/${year}/${month}/${day}?page=${page}`;
};

/** Advance a YYYY-MM-DD string by N days (default 1). */
const advanceDate = (dateStr: string, days: number = 1): string => {
  const parts = dateStr.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const iso = date.toISOString().split("T")[0];
  if (!iso) {
    panic(`Failed to format date from ${dateStr}`);
  }
  return iso;
};

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
  new Date().toISOString().split("T")[0] ?? "1970-01-01";

const defaultDate = (): string =>
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0] ??
  "1970-01-01";

export const czRegionalAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_REGIONAL,
  name: "Czech Regional Courts",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 200,
  // rozhodnuti.justice.cz returns 100 items per page; each
  // needs a finaldoc enrichment fetch. 30s default is too
  // tight for large pages with slow upstream responses.
  pageTimeoutMs: 100_000,

  async getTotalCount(_signal) {
    // The rozhodnuti.justice.cz API is date-based with no
    // single total count endpoint. There is no efficient way
    // to get the total without crawling all dates.
    return await Promise.resolve(null);
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const state: CursorState = cursor
          ? parseCursor(cursor)
          : { date: defaultDate(), page: 0, emptyDays: 0 };

        const url = buildDayUrl(state.date, state.page);
        const fetchT0 = performance.now();

        // Retry on timeout / 5xx up to LIST_FETCH_RETRIES times.
        let response: Response | undefined;
        for (let attempt = 0; attempt <= LIST_FETCH_RETRIES; attempt++) {
          if (signal?.aborted) {
            throw new DOMException("Cycle aborted", "AbortError");
          }

          try {
            response = await fetch(url, {
              signal: signal
                ? AbortSignal.any([
                    signal,
                    AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
                  ])
                : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
              headers: {
                Accept: "application/json",
                "User-Agent": INGESTION_USER_AGENT,
              },
            });
          } catch (fetchError) {
            if (isTimeoutError(fetchError) && !signal?.aborted) {
              if (attempt < LIST_FETCH_RETRIES) {
                const delayMs = LIST_FETCH_RETRY_DELAY_MS * (attempt + 1);
                logger.warn("case_law.ingestion.page_timeout_retry", {
                  adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
                  page: state.page,
                  date: state.date,
                  retry: attempt + 1,
                  maxRetries: LIST_FETCH_RETRIES,
                  retryDelayMs: delayMs,
                });
                await Bun.sleep(delayMs);
                continue;
              }
              logger.warn("case_law.ingestion.page_timeout_exhausted", {
                adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
                page: state.page,
                date: state.date,
                retries: LIST_FETCH_RETRIES,
              });
            }
            throw fetchError;
          }

          if (response.ok || response.status < 500) {
            break;
          }

          if (attempt < LIST_FETCH_RETRIES) {
            logger.warn("case_law.ingestion.page_server_error_retry", {
              adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
              page: state.page,
              date: state.date,
              httpStatus: response.status,
              retry: attempt + 1,
              maxRetries: LIST_FETCH_RETRIES,
            });
            await Bun.sleep(LIST_FETCH_RETRY_DELAY_MS);
          }
        }

        if (!response) {
          throw new AdapterFetchError({
            message: `CZ Regional: no response after ${LIST_FETCH_RETRIES} retries`,
            adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
            cursor,
          });
        }

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
        const items = json.items ?? [];

        const decisions: IngestionResult[] = [];
        for (const item of items) {
          const parsed = parseItem(item);
          if (parsed) {
            decisions.push(parsed);
          }
        }

        // Enrich decisions with fulltext + AST from /api/finaldoc.
        // Fetches run concurrently (batches of 10) to speed up
        // bulk ingestion while respecting the court server.
        const enrichDecision = async (decision: IngestionResult) => {
          if (!decision.documentUrl) {
            return;
          }

          const result = await fetchFinaldoc(
            decision.documentUrl,
            decision,
            signal,
          );

          if (result.fulltext) {
            decision.fulltext = result.fulltext;
          }
          if (result.decisionType) {
            decision.decisionType = result.decisionType;
          }
          decision.documentAst = result.documentAst;
          decision.sourceRaw = result.sourceRaw;
          decision.sourceRawContentType = "application/json";

          const rm = result.richMetadata;
          if (Object.keys(rm).length > 0) {
            decision.metadata = {
              ...decision.metadata,
              ...rm,
            };
          }
        };

        for (let i = 0; i < decisions.length; i += FINALDOC_CONCURRENCY) {
          if (i > 0) {
            await Bun.sleep(FINALDOC_BATCH_DELAY_MS);
          }
          await Promise.all(
            decisions.slice(i, i + FINALDOC_CONCURRENCY).map(enrichDecision),
          );
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
};
