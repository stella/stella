import { Result } from "better-result";

import { ADAPTER_KEYS, ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  adapterCatch,
  hashContent,
  parseCeDate,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";

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

/**
 * After this many consecutive empty pages we assume we've
 * passed the last case number for this year and move on.
 */
const MAX_CONSECUTIVE_MISSES = 100;

/** Decisions to collect per fetchPage call. */
const PAGE_SIZE = 20;

/** First year of the Constitutional Court's existence. */
const FIRST_YEAR = 1993;

/** Zero-pad 2-digit year suffix for NALUS URLs. */
const toYearSuffix = (year: number): string =>
  String(year % 100).padStart(2, "0");

const REGISTRY_SIGN_PATTERN = /^(.+?)\s+ze\s+dne\s+(.+)$/;
const DOC_CONTENT_PATTERN = /class="DocContent">([\s\S]*?)<\/table>/;
const JUDGE_PATTERN = /(\S+(?:\s+\S+){0,2})\s+\(soudce\s+zpravodaj\)/i;

/** Extract text from a labeled span. */
const extractLabel = (html: string, labelId: string): string | undefined => {
  const pattern = new RegExp(`id="${labelId}"[^>]*>([\\s\\S]*?)</span>`, "i");
  const match = html.match(pattern);
  if (!match?.[1]) {
    return;
  }
  return stripHtml(match[1]).trim() || undefined;
};

/** Extract case number and date from the registry sign. */
const parseRegistrySign = (
  raw: string,
): { caseNumber: string; decisionDate?: string | undefined } | null => {
  // Format: "Pl.ÚS 24/10 ze dne 22. 3. 2011"
  const match = raw.match(REGISTRY_SIGN_PATTERN);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    caseNumber: match[1].trim(),
    decisionDate: parseCeDate(match[2]),
  };
};

/** Extract fulltext body from DocContent table. */
const extractFulltext = (html: string): string | undefined => {
  const match = html.match(DOC_CONTENT_PATTERN);
  if (!match?.[1]) {
    return;
  }

  const text = stripHtml(match[1]);
  return text.length > 50 ? text : undefined;
};

/** Extract the rapporteur judge name from the body. */
const extractJudge = (html: string): string | undefined => {
  const match = html.match(JUDGE_PATTERN);
  return match?.[1] ? stripHtml(match[1]) : undefined;
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
  const raw = `${parsed.caseNumber}|${parsed.decisionDate}|${fulltext?.slice(0, 500)}`;

  return {
    caseNumber: parsed.caseNumber,
    court: "Ústavní soud",
    country: "CZE",
    language: "cs",
    decisionDate: parsed.decisionDate,
    decisionType: decisionForm?.toLowerCase(),
    fulltext,
    sourceUrl,
    metadata: {
      judge: judge || undefined,
      parallelQuotation: parallelQuotation || undefined,
      popularName: popularName || undefined,
    },
    rawHash: hashContent(raw),
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
    throw new TypeError("Invalid cz-constitutional cursor format");
  }

  return { number, year };
};

const makeCursor = (s: CursorState): string => `${s.number}:${s.year}`;

export const czConstitutionalAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_CONSTITUTIONAL,
  name: "Czech Constitutional Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 300,
  // Each fetchPage probes up to PAGE_SIZE + MAX_CONSECUTIVE_MISSES
  // case numbers sequentially (1 req/s). Default 30s is too short.
  pageTimeoutMs: 180_000,

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const callerSignal = signal;

        const state: CursorState = cursor
          ? parseCursor(cursor)
          : { number: 1, year: new Date().getFullYear() };

        const decisions: IngestionResult[] = [];
        let consecutiveMisses = 0;

        while (decisions.length < PAGE_SIZE) {
          const url = `${BASE_URL}?sz=I-${state.number}-${toYearSuffix(state.year)}_1`;

          try {
            const response = await fetch(url, {
              signal: callerSignal
                ? AbortSignal.any([
                    callerSignal,
                    AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
                  ])
                : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
            });

            if (response.ok) {
              const html = await response.text();
              const decision = parseDecisionPage(
                html,
                state.number,
                state.year,
              );

              if (decision) {
                decisions.push(decision);
                consecutiveMisses = 0;
              } else {
                consecutiveMisses++;
              }
            } else {
              consecutiveMisses++;
            }
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
              // Caller cancelled: return partial results
              // so the pipeline can persist cursor progress
              return {
                decisions,
                nextCursor: makeCursor(state),
              };
            }
            if (
              error instanceof DOMException &&
              error.name === "TimeoutError"
            ) {
              // Per-request timeout: treat as a miss
              consecutiveMisses++;
              await Bun.sleep(300);
              state.number++;
              if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
                if (state.year <= FIRST_YEAR) {
                  return {
                    decisions,
                    nextCursor: null,
                  };
                }
                state.number = 1;
                state.year -= 1;
                consecutiveMisses = 0;
              }
              continue;
            }
            // Unknown per-request error: propagate up
            // via the outer Result.tryPromise catch
            throw error;
          }

          // Rate limit between requests to NALUS
          await Bun.sleep(300);

          state.number++;

          // Too many misses: year exhausted, move back
          if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
            if (state.year <= FIRST_YEAR) {
              return { decisions, nextCursor: null };
            }
            state.number = 1;
            state.year -= 1;
            consecutiveMisses = 0;
          }
        }

        return {
          decisions,
          nextCursor: makeCursor(state),
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_CONSTITUTIONAL, cursor),
    });
  },
};
