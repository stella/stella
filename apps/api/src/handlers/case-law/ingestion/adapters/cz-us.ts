import { Result, panic } from "better-result";
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
import { fetchWithTimeout } from "@/api/lib/fetch";

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
 * Cursor format: "number:year:phase" (e.g. "100:2025:historical").
 * The phase segment is optional: a stored "number:year" predates it
 * and is read as a historical descent. A null cursor starts the
 * historical descent at the current year.
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

/**
 * Which sweep the cursor is in.
 *
 * NALUS has no list endpoint, so decisions are discovered by probing case
 * numbers. The first pass has to walk every year back to FIRST_YEAR; once
 * it has, descending through those years again re-fetches the whole corpus
 * to store nothing (rule 13). Holes the descent left behind belong to a
 * reconciliation pass, not to the live cursor (rule 16).
 */
const SWEEP_PHASE = {
  /** First pass: walking years backward toward FIRST_YEAR. */
  HISTORICAL: "historical",
  /** Descent done: only the recent window is swept, repeatedly. */
  RECENT: "recent",
} as const;

type SweepPhase = (typeof SWEEP_PHASE)[keyof typeof SWEEP_PHASE];

const SWEEP_PHASES: readonly SweepPhase[] = Object.values(SWEEP_PHASE);

/**
 * Years the steady-state sweep covers, counting the current one.
 *
 * A case number carries the year the case was filed, not the year it was
 * decided, and the Court often rules a year or two after filing. A window
 * of one year would therefore never see those decisions at all.
 */
const RECENT_WINDOW_YEARS = 3;

/** Oldest year the steady-state sweep may reach. */
export const recentWindowFloor = (currentYear: number): number =>
  Math.max(FIRST_YEAR, currentYear - RECENT_WINDOW_YEARS + 1);

/** Oldest year the given phase may descend to. */
const sweepFloor = (phase: SweepPhase, currentYear: number): number => {
  switch (phase) {
    case SWEEP_PHASE.HISTORICAL:
      return FIRST_YEAR;
    case SWEEP_PHASE.RECENT:
      return recentWindowFloor(currentYear);
    default: {
      const unhandled: never = phase;
      return panic(`Unhandled cz-us sweep phase: ${String(unhandled)}`);
    }
  }
};

/** Zero-pad 2-digit year suffix for NALUS URLs. */
const toYearSuffix = (year: number): string =>
  String(year % 100).padStart(2, "0");

const REGISTRY_SIGN_PATTERN =
  /^(?<caseNumber>\S+(?:\s\S+)*?)\s+ze\s+dne\s+(?<date>\S.*)$/u;
const DOC_CONTENT_PATTERN = /class="DocContent">(?<body>[\s\S]*?)<\/table>/u;

/**
 * The rapporteur is named immediately before this annotation. Matching
 * the annotation first keeps the scan linear: a pattern that instead
 * leads with the name (`\S+(?:\s+\S+){0,2}` and the like) has to retry
 * every offset in the document, and each retry walks the rest of the
 * current run of non-space characters, so the cost grows with the
 * square of the input.
 */
const JUDGE_ANNOTATION_PATTERN = /\(\s*soudce\s+zpravodaj\s*\)/iu;

/** Name tokens to keep ahead of the annotation. */
const JUDGE_TOKEN_LIMIT = 3;

/**
 * How far back to read for those tokens. A name plus its separators
 * never fills this, and bounding the window keeps extraction
 * independent of document size.
 */
const JUDGE_LOOKBACK_CHARS = 200;

/** Extract text from a labeled span. */
const extractLabel = (html: string, labelId: string): string | undefined => {
  const pattern = new RegExp(`id="${labelId}"[^>]*>([\\s\\S]*?)</span>`, "iu");
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
  const match =
    /^(?<senate>[IVX]+|Pl)\.ÚS\s+(?<caseIndex>\d+)\/(?<shortYear>\d+)$/u.exec(
      caseNumber,
    );
  const { senate, caseIndex, shortYear } = match?.groups ?? {};
  if (!senate || !caseIndex || !shortYear) {
    return undefined;
  }
  const mappedSenate = SENATE_MAP[senate] ?? senate.toUpperCase();
  return `ECLI:CZ:US:${decisionYear}:${mappedSenate}.US.${caseIndex}.${shortYear}.${counter}`;
};

/** Extract case number and date from the registry sign label. */
const parseRegistrySign = (
  raw: string,
): {
  caseNumber: string;
  decisionDate?: string | undefined;
} | null => {
  // Format: "Pl.ÚS 24/10 ze dne 22. 3. 2011" (visible label, no counter)
  const { caseNumber, date } = REGISTRY_SIGN_PATTERN.exec(raw)?.groups ?? {};
  if (!caseNumber || !date) {
    return null;
  }

  return {
    caseNumber: caseNumber.trim(),
    decisionDate: parseCeDate(date),
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
  const hidden = /name="registrySignHidden"[^>]*value="(?<value>[^"]*)"/u.exec(
    html,
  );
  const hiddenValue = hidden?.groups?.["value"];
  if (!hiddenValue) {
    return undefined;
  }
  const counter = /#(?<counter>\d+)/u.exec(hiddenValue)?.groups?.["counter"];
  return counter ? Number.parseInt(counter, 10) : undefined;
};

/** Plain text of the DocContent table, the decision body. */
const extractDocContentText = (html: string): string | undefined => {
  const body = DOC_CONTENT_PATTERN.exec(html)?.groups?.["body"];
  if (!body) {
    return undefined;
  }

  return stripHtml(body);
};

/** Extract fulltext body from DocContent table. */
const extractFulltext = (bodyText: string | undefined): string | undefined =>
  bodyText !== undefined && bodyText.length > 50 ? bodyText : undefined;

/**
 * Extract the rapporteur judge name from the decision body.
 *
 * Takes the body text rather than the page: the surrounding HTML
 * carries an ASP.NET `__VIEWSTATE` field, a single run of thousands of
 * non-space characters that costs far more to scan than the decision
 * itself and holds no name.
 */
const extractJudge = (bodyText: string): string | undefined => {
  const annotation = JUDGE_ANNOTATION_PATTERN.exec(bodyText);
  if (!annotation) {
    return undefined;
  }

  const tokens = bodyText
    .slice(
      Math.max(0, annotation.index - JUDGE_LOOKBACK_CHARS),
      annotation.index,
    )
    .split(/\s+/u)
    .filter(Boolean)
    .slice(-JUDGE_TOKEN_LIMIT);

  return tokens.length > 0 ? tokens.join(" ") : undefined;
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
  const bodyText = extractDocContentText(html);
  const fulltext = extractFulltext(bodyText);
  const judge = bodyText === undefined ? undefined : extractJudge(bodyText);

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

type CursorState = { number: number; year: number; phase: SweepPhase };

/**
 * Read the phase segment. Cursors stored before it existed are bare
 * "number:year" and are mid-descent by definition; an unrecognised
 * segment is a corrupt cursor and must not silently restart a sweep.
 */
const parsePhase = (segment: string | undefined): SweepPhase => {
  if (segment === undefined) {
    return SWEEP_PHASE.HISTORICAL;
  }
  const phase = SWEEP_PHASES.find((candidate) => candidate === segment);
  if (!phase) {
    throw new TypeError("Invalid cz-us cursor phase");
  }
  return phase;
};

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

  return { number, year, phase: parsePhase(parts.at(2)) };
};

const makeCursor = (s: CursorState): string =>
  `${s.number}:${s.year}:${s.phase}`;

export const czUsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_US,
  name: "Czech Constitutional Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 100,
  // Each fetchPage probes numbers in batches of PROBE_CONCURRENCY and
  // then fetches one abstract per hit, serially:
  // ~50 hits + 30 miss gap = ~80 probes ÷ 5 = 16 batches × ~2s = ~32s,
  // plus ~50 abstract fetches × ~0.5s = ~25s, so ~55s per page.
  //
  // maxSyncPages × pageTimeoutMs (10 × 120s) is below maxCycleMs, so the
  // page budget is reachable even when every page runs to its timeout.
  // A cycle that cannot reach it always ends as TIMEOUT, and the runner
  // only backs off (cycle-progress `cycleWasIdle`) on a COMPLETED cycle
  // that inserted nothing, so an unreachable budget pins a caught-up
  // adapter to the 5s cadence and starves the other adapters.
  pageTimeoutMs: 120_000,
  maxSyncPages: 10,
  maxCycleMs: 30 * 60 * 1000,

  /**
   * NALUS reports its total only on a search result page, and a search
   * demands a session: the form's ViewState fields and cookies from a GET,
   * a POST carrying them plus at least one criterion (an all-inclusive date
   * range excludes nothing), then the redirected results page, which states
   * "z celkem N".
   */
  async getTotalCount(signal) {
    try {
      const searchUrl = "https://nalus.usoud.cz/Search/Search.aspx";
      const first = await fetchWithTimeout(searchUrl, {
        signal,
        timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      });
      if (!first.ok) {
        return null;
      }
      const cookies = first.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const html = await first.text();
      const hidden = (name: string): string | null => {
        const match = new RegExp(`id="${name}" value="([^"]*)"`, "u").exec(
          html,
        );
        return match?.[1] ?? null;
      };
      const viewState = hidden("__VIEWSTATE");
      const generator = hidden("__VIEWSTATEGENERATOR");
      const validation = hidden("__EVENTVALIDATION");
      if (viewState === null || validation === null) {
        return null;
      }
      const form = new URLSearchParams({
        __VIEWSTATE: viewState,
        ...(generator === null ? {} : { __VIEWSTATEGENERATOR: generator }),
        __EVENTVALIDATION: validation,
        ctl00$MainContent$nalezy: "on",
        ctl00$MainContent$usneseni: "on",
        ctl00$MainContent$stanoviska_plena: "on",
        ctl00$MainContent$decidedFrom: "1.1.1900",
        ctl00$MainContent$decidedTo: `31.12.${new Date().getFullYear() + 1}`,
        ctl00$MainContent$but_search: "Vyhledat",
      });
      const submit = await fetchWithTimeout(searchUrl, {
        method: "POST",
        signal,
        redirect: "manual",
        timeoutMs: ADAPTER_TIMEOUT.REQUEST,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookies,
        },
        body: form.toString(),
      });
      if (submit.status !== 302 && !submit.ok) {
        return null;
      }
      const results = await fetchWithTimeout(
        "https://nalus.usoud.cz/Search/Results.aspx",
        {
          signal,
          timeoutMs: ADAPTER_TIMEOUT.REQUEST,
          headers: { Cookie: cookies },
        },
      );
      if (!results.ok) {
        return null;
      }
      const total = /z celkem (?<n>\d+)/u.exec(await results.text())?.groups?.[
        "n"
      ];
      const parsed =
        total === undefined ? Number.NaN : Number.parseInt(total, 10);
      return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
    } catch {
      return null;
    }
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const callerSignal = signal;
        const currentYear = new Date().getFullYear();

        const state: CursorState = cursor
          ? parseCursor(cursor)
          : { number: 1, year: currentYear, phase: SWEEP_PHASE.HISTORICAL };

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

          // oxlint-disable-next-line no-await-in-loop -- sequential probe batches; each batch advances the cursor based on the previous batch's results and consecutive-miss count
          const probeResults = await Promise.allSettled(
            Array.from({ length: PROBE_CONCURRENCY }, async (_, i) => {
              const num = state.number + i;
              const url = `${BASE_URL}?sz=I-${num}-${yearSuffix}_1`;
              const response = await fetchWithTimeout(url, {
                headers: COMMON_HEADERS,
                signal: callerSignal,
                timeoutMs: ADAPTER_TIMEOUT.REQUEST,
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
            if (probe.status !== "ok") {
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
              // oxlint-disable-next-line no-await-in-loop -- sequential per-decision abstract fetch within the ordered result-processing loop
              const absResp = await fetchWithTimeout(
                `${ABSTRACT_URL}?sz=${szParam}`,
                {
                  headers: COMMON_HEADERS,
                  signal: callerSignal,
                  timeoutMs: ADAPTER_TIMEOUT.REQUEST,
                },
              );
              if (absResp.ok) {
                // oxlint-disable-next-line no-await-in-loop -- reads the body of the per-decision abstract fetch in this ordered loop
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
            // oxlint-disable-next-line no-await-in-loop -- rate-limit backoff between probe batches after a 429 from the court server
            await Bun.sleep(backoffMs(0, 2000));
          }

          // Too many consecutive numbers with no decisions: year
          // exhausted, move to the previous year within the phase's
          // range. Below that range the sweep restarts at the top of
          // the recent window; the historical descent hands over to the
          // recent phase there and never walks the completed years again.
          if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
            if (
              state.year <= sweepFloor(state.phase, currentYear) ||
              state.year > currentYear
            ) {
              return {
                decisions,
                nextCursor: makeCursor({
                  number: 1,
                  year: currentYear,
                  phase: SWEEP_PHASE.RECENT,
                }),
              };
            }
            state.number = 1;
            state.year -= 1;
            consecutiveMisses = 0;
          }

          // Rate limit between batches
          // oxlint-disable-next-line no-await-in-loop -- deliberate crawl delay between sequential probe batches against the court server
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
