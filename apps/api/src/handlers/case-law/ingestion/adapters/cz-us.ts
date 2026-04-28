import { Result } from "better-result";
import * as cheerio from "cheerio";

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
import { backoffMs } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  parseCeDate,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseUsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-us";

const COMMON_HEADERS = {
  "User-Agent": INGESTION_USER_AGENT,
} as const;

/**
 * Czech Constitutional Court (Ústavní soud) adapter.
 *
 * Scrapes the NALUS database at nalus.usoud.cz. Each decision
 * has a predictable URL keyed by case number and year:
 *
 *   GetText.aspx?sz=I-{number}-{year}_1
 *
 * The senate prefix in the URL is ignored by the server;
 * case numbers are sequential across all senates (I, II,
 * III, IV, Pl) within a year. ~3500 cases/year.
 *
 * Empty pages (non-existent numbers) return HTTP 200 with
 * no "ze dne" in the registry sign.
 *
 * Cursor format: "number:year" (e.g. "100:2025").
 * A null cursor starts from the current year.
 */

const BASE_URL = "https://nalus.usoud.cz/Search/GetText.aspx";
const ABSTRACT_URL = "https://nalus.usoud.cz/Search/GetAbstract.aspx";

/**
 * After this many consecutive empty numbers we assume the
 * year is exhausted. Real gaps are tiny (max ~5 in any year);
 * 30 gives a wide safety margin without wasting probes.
 */
const MAX_CONSECUTIVE_MISSES = 30;

/** Decisions to collect per fetchPage call. */
const PAGE_SIZE = 50;

/** Number of case numbers to probe concurrently. */
const PROBE_CONCURRENCY = 5;

/** First year of the Constitutional Court's existence. */
const FIRST_YEAR = 1993;

/** Zero-pad 2-digit year suffix for NALUS URLs. */
const toYearSuffix = (year: number): string =>
  String(year % 100).padStart(2, "0");

// oxlint-disable-next-line sonarjs/slow-regex -- registry sign is a short label extracted from NALUS metadata
const REGISTRY_SIGN_PATTERN = /^(.+?)\s+ze\s+dne\s+(.+)$/;
const DOC_CONTENT_PATTERN = /class="DocContent">([\s\S]*?)<\/table>/;
// oxlint-disable-next-line sonarjs/slow-regex -- judge extraction scans one decision signature block
const JUDGE_PATTERN = /(\S+(?:\s+\S+){0,2})\s+\(soudce\s+zpravodaj\)/i;

/** Extract text from a labeled span. */
const extractLabel = (html: string, labelId: string): string | undefined => {
  const pattern = new RegExp(`id="${labelId}"[^>]*>([\\s\\S]*?)</span>`, "i");
  const match = html.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }
  return stripHtml(match[1]).trim() || undefined;
};

/**
 * Roman numeral senate prefix → number for ECLI.
 * Pl (Plenary) is not mapped here; it is normalized
 * to uppercase "PL" in buildEcli via explicit handling.
 */
const SENATE_MAP: Record<string, string> = {
  I: "1",
  II: "2",
  III: "3",
  IV: "4",
};

/**
 * Build ECLI from parsed case number components.
 *
 * Format: ECLI:CZ:US:{year}:{senate}.US.{index}.{shortYear}.{counter}
 * Example: II.ÚS 3436/14 #1, year 2016 → ECLI:CZ:US:2016:2.US.3436.14.1
 *
 * The counter comes from the registry sign (`#1`), not hardcoded.
 * Returns undefined if any component can't be parsed.
 */
const buildEcli = (
  caseNumber: string,
  decisionYear: number,
  counter: number,
): string | undefined => {
  // "II.ÚS 3436/14" or "Pl.ÚS 24/10"
  const match = /^([IVX]+|Pl)\.ÚS\s+(\d+)\/(\d+)$/.exec(caseNumber);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  const senate = SENATE_MAP[match[1]] ?? match[1].toUpperCase();
  return `ECLI:CZ:US:${decisionYear}:${senate}.US.${match[2]}.${match[3]}.${counter}`;
};

/** Extract case number and date from the registry sign label. */
const parseRegistrySign = (
  raw: string,
): {
  caseNumber: string;
  decisionDate?: string | undefined;
} | null => {
  // Format: "Pl.ÚS 24/10 ze dne 22. 3. 2011" (visible label, no counter)
  const match = REGISTRY_SIGN_PATTERN.exec(raw);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    caseNumber: match[1].trim(),
    decisionDate: parseCeDate(match[2]),
  };
};

/**
 * Extract ECLI counter from the hidden registry sign field.
 *
 * The visible lblRegistrySign omits the counter, but
 * registrySignHidden includes it: "I.ÚS 100/25 #1 ze dne ...".
 * Returns undefined if the counter is not present.
 */
const extractEcliCounter = (html: string): number | undefined => {
  const hidden = /name="registrySignHidden"[^>]*value="([^"]*)"/.exec(html);
  if (!hidden?.[1]) {
    return undefined;
  }
  const counterMatch = /#(\d+)/.exec(hidden[1]);
  return counterMatch?.[1] ? Number.parseInt(counterMatch[1], 10) : undefined;
};

/** Extract fulltext body from DocContent table. */
const extractFulltext = (html: string): string | undefined => {
  const match = DOC_CONTENT_PATTERN.exec(html);
  if (!match?.[1]) {
    return undefined;
  }

  const text = stripHtml(match[1]);
  return text.length > 50 ? text : undefined;
};

/** Extract the rapporteur judge name from the body. */
const extractJudge = (html: string): string | undefined => {
  const match = JUDGE_PATTERN.exec(html);
  return match?.[1] ? stripHtml(match[1]) : undefined;
};

/** Extract abstract and legal sentence from GetAbstract.aspx. */
const extractAbstract = (
  html: string,
): {
  abstract?: string;
  legalSentence?: string;
} => {
  const $ = cheerio.load(html);
  const abstractText = $("table.abstractContent td").text().trim();
  const legalText = $("table.legalSentenceContent td").text().trim();

  const result: { abstract?: string; legalSentence?: string } = {};
  if (abstractText.length > 20) {
    result.abstract = abstractText;
  }
  if (legalText.length > 20) {
    result.legalSentence = legalText;
  }
  return result;
};

const parseDecisionPage = (
  html: string,
  number: number,
  year: number,
): IngestionResult | null => {
  const registrySign = extractLabel(html, "lblRegistrySign");
  if (!registrySign?.includes("ze dne")) {
    return null; // Empty page
  }

  const parsed = parseRegistrySign(registrySign);
  if (!parsed) {
    return null;
  }

  const decisionForm = extractLabel(html, "lblDecisionForm");
  const parallelQuotation = extractLabel(html, "lblParallelQuotation");
  const popularName = extractLabel(html, "lblPopularName");
  const fulltext = extractFulltext(html);
  const judge = extractJudge(html);

  const sourceUrl = `${BASE_URL}?sz=I-${number}-${toYearSuffix(year)}_1`;

  // Build ECLI from case number + decision year + counter.
  // Counter comes from registrySignHidden (not the visible label).
  // ECLI is only built when both decision year and counter are known.
  const decisionYear = parsed.decisionDate
    ? Number.parseInt(parsed.decisionDate.slice(0, 4), 10)
    : undefined;
  const ecliCounter = extractEcliCounter(html);
  const ecli =
    decisionYear !== undefined && ecliCounter !== undefined
      ? buildEcli(parsed.caseNumber, decisionYear, ecliCounter)
      : undefined;

  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- AST container, not a DB update
  let documentAst: DocumentAst | EmptyAst = EMPTY_AST;
  let resolvedFulltext = fulltext;

  try {
    const parserResult = parseUsDecisionHtml({
      html,
      caseNumber: parsed.caseNumber,
      ecli,
      court: "Ústavní soud",
      decisionDate: parsed.decisionDate,
      decisionType: decisionForm?.toLowerCase(),
    });
    documentAst = parserResult.documentAst;
    resolvedFulltext = parserResult.fulltext;
  } catch {
    // Parser failed; fall back to empty AST and
    // stripHtml-based fulltext extraction.
  }

  // Hash on identity fields only (not fulltext) for stability
  // across parser changes. Matches NSS adapter pattern.
  const raw = `${parsed.caseNumber}|${parsed.decisionDate ?? ""}`;

  return {
    caseNumber: parsed.caseNumber,
    ecli,
    court: "Ústavní soud",
    country: "CZE",
    language: "cs",
    decisionDate: parsed.decisionDate,
    decisionType: decisionForm?.toLowerCase(),
    fulltext: resolvedFulltext,
    sourceUrl,
    metadata: {
      caseNumber: parsed.caseNumber,
      ecli,
      court: "Ústavní soud" as const,
      decisionDate: parsed.decisionDate,
      decisionType: decisionForm?.toLowerCase(),
      judge: judge || undefined,
      parallelQuotation: parallelQuotation || undefined,
      popularName: popularName || undefined,
      ecliCounter,
    },
    rawHash: hashContent(raw),
    parserVersion: PARSER_VERSION,
    documentAst,
    sourceRaw: html,
    sourceRawContentType: "text/html",
  };
};

type CursorState = { number: number; year: number };

const parseCursor = (cursor: string): CursorState => {
  const parts = cursor.split(":");
  const number = Number.parseInt(parts.at(0) ?? "1", 10);
  const year = Number.parseInt(
    parts.at(1) ?? String(new Date().getFullYear()),
    10,
  );

  if (Number.isNaN(number) || Number.isNaN(year)) {
    throw new TypeError("Invalid cz-us cursor format");
  }

  return { number, year };
};

const makeCursor = (s: CursorState): string => `${s.number}:${s.year}`;

export const czUsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_US,
  name: "Czech Constitutional Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 100,
  // Each fetchPage probes numbers in batches of PROBE_CONCURRENCY.
  // ~50 hits + 30 miss gap = ~80 probes ÷ 5 = 16 batches × ~2s = 32s.
  pageTimeoutMs: 120_000,
  maxSyncPages: 20,

  // TODO: NALUS requires a POST with ASP.NET ViewState to
  // return search results. A GET to the search page returns
  // the form but no count. Implement POST-based total count
  // when we add full ÚS historical ingestion.
  // eslint-disable-next-line require-await -- interface requires Promise
  async getTotalCount(_signal) {
    return null;
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const callerSignal = signal;
        const currentYear = new Date().getFullYear();

        const state: CursorState = cursor
          ? parseCursor(cursor)
          : { number: 1, year: currentYear };

        const decisions: IngestionResult[] = [];
        let consecutiveMisses = 0;

        while (decisions.length < PAGE_SIZE) {
          if (callerSignal?.aborted) {
            return { decisions, nextCursor: makeCursor(state) };
          }

          // Probe PROBE_CONCURRENCY numbers at once. Most are
          // misses (~97%), so concurrent probing cuts wall time
          // by ~5x without meaningful server load increase.
          const yearSuffix = toYearSuffix(state.year);

          const probeResults = await Promise.allSettled(
            Array.from({ length: PROBE_CONCURRENCY }, async (_, i) => {
              const num = state.number + i;
              const url = `${BASE_URL}?sz=I-${num}-${yearSuffix}_1`;
              const response = await fetch(url, {
                headers: COMMON_HEADERS,
                signal: callerSignal
                  ? AbortSignal.any([
                      callerSignal,
                      AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
                    ])
                  : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
              });
              if (response.status === 429) {
                return { num, status: "rate-limited" as const };
              }
              if (!response.ok) {
                return { num, status: "miss" as const };
              }
              const html = await response.text();
              return { num, status: "ok" as const, html };
            }),
          );

          // Process results in order to maintain consecutive miss tracking.
          // batchStart lets early exits preserve cursor progress.
          const batchStart = state.number;
          let rateLimited = false;
          for (const [i, result] of probeResults.entries()) {
            if (callerSignal?.aborted) {
              state.number = batchStart + i;
              return { decisions, nextCursor: makeCursor(state) };
            }

            if (result.status === "rejected") {
              const error: unknown = result.reason;
              if (
                error instanceof DOMException &&
                error.name === "AbortError"
              ) {
                state.number = batchStart + i;
                return { decisions, nextCursor: makeCursor(state) };
              }
              // Per-request timeout: treat as miss. Other errors:
              // propagate so the pipeline can handle them.
              if (
                !(error instanceof DOMException) ||
                error.name !== "TimeoutError"
              ) {
                state.number = batchStart + i;
                throw error;
              }
              consecutiveMisses++;
              continue;
            }

            const probe = result.value;
            if (probe.status === "rate-limited") {
              // Set cursor to the rate-limited item so
              // unprocessed probes after it are retried.
              state.number = batchStart + i;
              rateLimited = true;
              break;
            }
            if (probe.status === "miss" || !("html" in probe)) {
              consecutiveMisses++;
              continue;
            }

            const decision = parseDecisionPage(
              probe.html,
              probe.num,
              state.year,
            );
            if (!decision) {
              consecutiveMisses++;
              continue;
            }

            // Fetch abstract + legal sentence (separate endpoint)
            try {
              const szParam = `I-${probe.num}-${yearSuffix}_1`;
              const absSignal = callerSignal
                ? AbortSignal.any([
                    callerSignal,
                    AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
                  ])
                : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST);
              const absResp = await fetch(`${ABSTRACT_URL}?sz=${szParam}`, {
                headers: COMMON_HEADERS,
                signal: absSignal,
              });
              if (absResp.ok) {
                const absHtml = await absResp.text();
                const { abstract, legalSentence } = extractAbstract(absHtml);
                if (abstract) {
                  decision.metadata["abstract"] = abstract;
                }
                if (legalSentence) {
                  decision.metadata["legalSentence"] = legalSentence;
                }
                decision.sourceRaw = JSON.stringify({
                  textHtml: decision.sourceRaw,
                  abstractHtml: absHtml,
                });
              }
            } catch {
              // Abstract fetch failed; proceed without it
            }

            decisions.push(decision);
            consecutiveMisses = 0;
          }

          // Only advance past full batch if no rate limit hit.
          // On 429, state.number was set to the failing item above.
          if (!rateLimited) {
            state.number += PROBE_CONCURRENCY;
          } else {
            await Bun.sleep(backoffMs(0, 2000));
          }

          // Too many consecutive numbers with no decisions:
          // year exhausted, move to previous year (or park).
          if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
            if (state.year <= FIRST_YEAR || state.year > currentYear) {
              return {
                decisions,
                nextCursor: `1:${currentYear}`,
              };
            }
            state.number = 1;
            state.year -= 1;
            consecutiveMisses = 0;
          }

          // Rate limit between batches
          await Bun.sleep(100);
        }

        return {
          decisions,
          nextCursor: makeCursor(state),
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_US, cursor),
    });
  },
};
