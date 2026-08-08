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
 * Scrapes the NALUS database at nalus.usoud.cz through its public search UI.
 * NALUS has no JSON API, but its WebForms search is a complete, paginated
 * enumeration surface. Each result carries the court's exact GetText.aspx
 * identifier and its internal record id.
 *
 * Never reconstruct a GetText identifier from a docket. Historical NALUS
 * identifiers use a different grammar, chamber numbering was not globally
 * sequential, plenary dockets overlap chamber numbers, and one docket can
 * publish several decisions. Probing `I-{number}-{year}_1` loses all of those
 * distinctions.
 *
 * Cursor formats:
 *   search:historical:<decision-year>:<zero-based-page>
 *   search:recent:<available-from>:<available-to>:<zero-based-page>
 *
 * A null or legacy probe cursor starts the search-based historical repair at
 * FIRST_YEAR. This intentionally re-enumerates history once: it migrates the
 * incomplete probe crawl onto publisher-stated document identities.
 */

const ABSTRACT_URL = "https://nalus.usoud.cz/Search/GetAbstract.aspx";
const SEARCH_URL = "https://nalus.usoud.cz/Search/Search.aspx";
const RESULTS_URL = "https://nalus.usoud.cz/Search/Results.aspx";

/** Largest result size that keeps one page's text fetches reasonably bounded. */
const RESULTS_PAGE_SIZE = 40;

/** Detail/abstract pairs fetched concurrently from the court. */
const DOCUMENT_CONCURRENCY = 5;

/** First year of the Constitutional Court's existence. */
const FIRST_YEAR = 1993;

const SWEEP_PHASE = {
  /** One-time complete enumeration by decision year. */
  HISTORICAL: "historical",
  /** Steady state: enumerate the source's recent publication window. */
  RECENT: "recent",
} as const;

/**
 * NALUS exposes availability dates only for a rolling recent index. Replaying
 * a generous window makes ordinary scheduler interruptions self-healing while
 * keeping steady-state work bounded.
 */
const RECENT_WINDOW_DAYS = 45;

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
  sourceUrl: string,
  sourceDocumentId: string,
  listedEcli: string | undefined,
  nalusRecordId: string,
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

  // Build ECLI from case number + decision year + counter.
  // Counter comes from registrySignHidden (not the visible label).
  // ECLI is only built when both decision year and counter are known.
  const decisionYear = parsed.decisionDate
    ? Number.parseInt(parsed.decisionDate.slice(0, 4), 10)
    : undefined;
  const ecliCounter = extractEcliCounter(html);
  const ecli =
    listedEcli ??
    (decisionYear !== undefined && ecliCounter !== undefined
      ? buildEcli(parsed.caseNumber, decisionYear, ecliCounter)
      : undefined);

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
  const raw = `${sourceDocumentId}|${parsed.caseNumber}|${parsed.decisionDate ?? ""}`;

  return {
    caseNumber: parsed.caseNumber,
    sourceDocumentId,
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
      nalusRecordId,
    },
    rawHash: hashContent(raw),
    parserVersion: PARSER_VERSION,
    documentAst,
    sourceRaw: html,
    sourceRawContentType: "text/html",
  };
};

type HistoricalCursor = {
  phase: typeof SWEEP_PHASE.HISTORICAL;
  year: number;
  page: number;
};

type RecentCursor = {
  phase: typeof SWEEP_PHASE.RECENT;
  availableFrom: string;
  availableTo: string;
  page: number;
};

type CursorState = HistoricalCursor | RecentCursor;

type ListedDecision = {
  sourceDocumentId: string;
  nalusRecordId: string;
  sourceUrl: string;
  sz: string;
  ecli?: string | undefined;
};

type SearchPage = {
  listed: ListedDecision[];
  rangeFrom: number;
  rangeTo: number;
  reported: number;
};

const historicalStart = (): HistoricalCursor => ({
  phase: SWEEP_PHASE.HISTORICAL,
  year: FIRST_YEAR,
  page: 0,
});

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const LEGACY_CURSOR_PATTERN = /^\d+:\d{4}(?::(?:historical|recent))?$/u;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const czechDate = (date: Date): string =>
  `${date.getUTCDate()}.${date.getUTCMonth() + 1}.${date.getUTCFullYear()}`;

const recentStart = (now: Date): RecentCursor => {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - RECENT_WINDOW_DAYS + 1);
  return {
    phase: SWEEP_PHASE.RECENT,
    availableFrom: isoDay(from),
    availableTo: isoDay(now),
    page: 0,
  };
};

const parseNonNegativeInteger = (
  value: string | undefined,
  field: string,
): number => {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`Invalid cz-us cursor ${field}`);
  }
  return parsed;
};

const parseCursor = (cursor: string): CursorState => {
  // The old probe cursor cannot be translated faithfully: it says which
  // guessed number came next, not which publisher documents were covered.
  // Restart the one-time publisher enumeration to repair that uncertainty.
  if (LEGACY_CURSOR_PATTERN.test(cursor)) {
    return historicalStart();
  }

  const parts = cursor.split(":");
  if (parts.at(0) !== "search") {
    throw new TypeError("Invalid cz-us cursor version");
  }

  const phase = parts.at(1);
  if (phase === SWEEP_PHASE.HISTORICAL && parts.length === 4) {
    const year = parseNonNegativeInteger(parts.at(2), "year");
    if (year < FIRST_YEAR) {
      throw new TypeError("Invalid cz-us cursor year");
    }
    return {
      phase,
      year,
      page: parseNonNegativeInteger(parts.at(3), "page"),
    };
  }
  if (phase === SWEEP_PHASE.RECENT && parts.length === 5) {
    const availableFrom = parts.at(2);
    const availableTo = parts.at(3);
    if (
      !availableFrom ||
      !availableTo ||
      !ISO_DAY_PATTERN.test(availableFrom) ||
      !ISO_DAY_PATTERN.test(availableTo) ||
      availableFrom > availableTo
    ) {
      throw new TypeError("Invalid cz-us availability window");
    }
    return {
      phase,
      availableFrom,
      availableTo,
      page: parseNonNegativeInteger(parts.at(4), "page"),
    };
  }
  throw new TypeError("Invalid cz-us cursor phase");
};

const makeCursor = (state: CursorState): string => {
  switch (state.phase) {
    case SWEEP_PHASE.HISTORICAL:
      return `search:${state.phase}:${state.year}:${state.page}`;
    case SWEEP_PHASE.RECENT:
      return `search:${state.phase}:${state.availableFrom}:${state.availableTo}:${state.page}`;
    default: {
      const unhandled: never = state;
      return panic(`Unhandled cz-us cursor: ${String(unhandled)}`);
    }
  }
};

const nextSlice = (state: CursorState, now: Date): CursorState => {
  switch (state.phase) {
    case SWEEP_PHASE.HISTORICAL:
      return state.year < now.getUTCFullYear()
        ? { phase: state.phase, year: state.year + 1, page: 0 }
        : recentStart(now);
    case SWEEP_PHASE.RECENT:
      return recentStart(now);
    default: {
      const unhandled: never = state;
      return panic(`Unhandled cz-us cursor: ${String(unhandled)}`);
    }
  }
};

const coverageSlice = (state: CursorState): string => {
  switch (state.phase) {
    case SWEEP_PHASE.HISTORICAL:
      return `decision-year:${state.year}`;
    case SWEEP_PHASE.RECENT:
      return `availability:${state.availableFrom}:${state.availableTo}`;
    default: {
      const unhandled: never = state;
      return panic(`Unhandled cz-us cursor: ${String(unhandled)}`);
    }
  }
};

const hiddenField = (html: string, name: string): string | undefined =>
  cheerio.load(html)(`#${name}`).attr("value");

const cookieHeader = (responses: readonly Response[]): string => {
  const cookies = new Map<string, string>();
  for (const response of responses) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";").at(0);
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) {
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
};

const searchFields = (state: CursorState): Record<string, string> => {
  switch (state.phase) {
    case SWEEP_PHASE.HISTORICAL:
      return {
        ctl00$MainContent$decidedFrom: `1.1.${state.year}`,
        ctl00$MainContent$decidedTo: `31.12.${state.year}`,
        ctl00$MainContent$razeni: "3",
      };
    case SWEEP_PHASE.RECENT:
      return {
        ctl00$MainContent$dle_data_zpristupneni: "on",
        ctl00$MainContent$availableFrom: czechDate(
          new Date(`${state.availableFrom}T00:00:00Z`),
        ),
        ctl00$MainContent$availableTo: czechDate(
          new Date(`${state.availableTo}T00:00:00Z`),
        ),
        ctl00$MainContent$razeni: "20",
      };
    default: {
      const unhandled: never = state;
      return panic(`Unhandled cz-us cursor: ${String(unhandled)}`);
    }
  }
};

const parseResultPage = (html: string, expectedPage: number): SearchPage => {
  const banners = [
    ...html.matchAll(
      /Výsledky\s+(?<from>\d+)\s*-\s*(?<to>\d+)\s+z\s+celkem\s+(?<total>\d+)/gu,
    ),
  ].map(({ groups }) => ({
    rangeFrom: Number(groups?.["from"]),
    rangeTo: Number(groups?.["to"]),
    reported: Number(groups?.["total"]),
  }));
  const banner = banners.at(0);
  if (!banner) {
    throw new TypeError("NALUS result count banner is missing");
  }
  if (
    banners.some(
      (candidate) =>
        candidate.rangeFrom !== banner.rangeFrom ||
        candidate.rangeTo !== banner.rangeTo ||
        candidate.reported !== banner.reported,
    )
  ) {
    throw new TypeError("NALUS result count banners disagree");
  }

  const expectedFrom = expectedPage * RESULTS_PAGE_SIZE + 1;
  if (banner.rangeFrom !== expectedFrom || banner.rangeTo > banner.reported) {
    throw new TypeError("NALUS returned an unexpected result page");
  }

  const $ = cheerio.load(html);
  const listed: ListedDecision[] = [];
  $("tr.resultData0, tr.resultData1").each((_, row) => {
    const primary = $(row);
    if (primary.attr("valign") === "top") {
      return;
    }
    const detail = primary.find("a[href*='ResultDetail.aspx?id=']").first();
    const detailHref = detail.attr("href");
    const nalusRecordId = /[?&]id=(?<id>\d+)/u.exec(detailHref ?? "")?.groups?.[
      "id"
    ];
    const actions = primary.next("tr");
    const linkAction = actions
      .find("[onclick*='GetText.aspx?sz=']")
      .first()
      .attr("onclick");
    const rawUrl =
      /ShowLink\("(?<url>https?:\/\/[^"]+GetText\.aspx\?sz=[^"]+)"/u.exec(
        linkAction ?? "",
      )?.groups?.["url"];
    if (!nalusRecordId || !rawUrl) {
      throw new TypeError("NALUS result row is missing document identity");
    }
    const url = new URL(rawUrl);
    url.port = "";
    const sz = url.searchParams.get("sz");
    if (!sz) {
      throw new TypeError("NALUS result row is missing its sz identifier");
    }
    const ecli = /ECLI:CZ:US:[^<\s]+/u.exec(primary.html() ?? "")?.at(0);
    listed.push({
      sourceDocumentId: `nalus:${sz}`,
      nalusRecordId,
      sourceUrl: url.href,
      sz,
      ecli,
    });
  });

  const expectedRows = banner.rangeTo - banner.rangeFrom + 1;
  if (
    listed.length !== expectedRows ||
    new Set(listed.map(({ sourceDocumentId }) => sourceDocumentId)).size !==
      listed.length
  ) {
    throw new TypeError("NALUS result rows do not match the count banner");
  }
  return { listed, ...banner };
};

const fetchSearchPage = async (
  state: CursorState,
  signal: AbortSignal | undefined,
): Promise<SearchPage | null> => {
  const first = await fetchWithTimeout(SEARCH_URL, {
    headers: COMMON_HEADERS,
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });
  if (!first.ok) {
    throw new TypeError(`NALUS search form returned HTTP ${first.status}`);
  }
  const formHtml = await first.text();
  const viewState = hiddenField(formHtml, "__VIEWSTATE");
  const validation = hiddenField(formHtml, "__EVENTVALIDATION");
  if (!viewState || !validation) {
    throw new TypeError("NALUS search form is missing WebForms state");
  }

  const form = new URLSearchParams({
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    __VIEWSTATE: viewState,
    ...(hiddenField(formHtml, "__VIEWSTATEGENERATOR")
      ? {
          __VIEWSTATEGENERATOR:
            hiddenField(formHtml, "__VIEWSTATEGENERATOR") ?? "",
        }
      : {}),
    __EVENTVALIDATION: validation,
    ctl00$MainContent$nalezy: "on",
    ctl00$MainContent$usneseni: "on",
    ctl00$MainContent$stanoviska_plena: "on",
    ctl00$MainContent$resultsPageSize: String(RESULTS_PAGE_SIZE),
    ctl00$MainContent$resultsFontSize: "10",
    ctl00$MainContent$but_search: "Vyhledat",
    ...searchFields(state),
  });
  const initialCookies = cookieHeader([first]);
  const submit = await fetchWithTimeout(SEARCH_URL, {
    method: "POST",
    signal,
    redirect: "manual",
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: initialCookies,
      Referer: SEARCH_URL,
    },
    body: form.toString(),
  });
  if (submit.status !== 302) {
    if (submit.ok) {
      return null;
    }
    throw new TypeError(`NALUS search returned HTTP ${submit.status}`);
  }

  const cookies = cookieHeader([first, submit]);
  const pageUrl =
    state.page === 0 ? RESULTS_URL : `${RESULTS_URL}?page=${state.page}`;
  const results = await fetchWithTimeout(pageUrl, {
    headers: { ...COMMON_HEADERS, Cookie: cookies },
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });
  if (!results.ok) {
    throw new TypeError(`NALUS results returned HTTP ${results.status}`);
  }
  return parseResultPage(await results.text(), state.page);
};

const fetchListedDecision = async (
  listed: ListedDecision,
  signal: AbortSignal | undefined,
): Promise<IngestionResult> => {
  const response = await fetchWithTimeout(listed.sourceUrl, {
    headers: COMMON_HEADERS,
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });
  if (!response.ok) {
    throw new TypeError(
      `NALUS decision ${listed.sourceDocumentId} returned HTTP ${response.status}`,
    );
  }
  const decision = parseDecisionPage(
    await response.text(),
    listed.sourceUrl,
    listed.sourceDocumentId,
    listed.ecli,
    listed.nalusRecordId,
  );
  if (!decision) {
    throw new TypeError(
      `NALUS listed ${listed.sourceDocumentId} without a parseable decision`,
    );
  }

  try {
    const abstractQuery = new URLSearchParams({ sz: listed.sz });
    const abstractResponse = await fetchWithTimeout(
      `${ABSTRACT_URL}?${abstractQuery.toString()}`,
      {
        headers: COMMON_HEADERS,
        signal,
        timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      },
    );
    if (abstractResponse.ok) {
      const abstractHtml = await abstractResponse.text();
      const { abstract, legalSentence } = extractAbstract(abstractHtml);
      if (abstract) {
        decision.metadata["abstract"] = abstract;
      }
      if (legalSentence) {
        decision.metadata["legalSentence"] = legalSentence;
      }
      decision.sourceRaw = JSON.stringify({
        textHtml: decision.sourceRaw,
        abstractHtml,
      });
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // Abstracts are optional enrichment; the listed decision is complete
    // enough to ingest without one.
  }
  return decision;
};

const fetchListedDecisions = async (
  listed: readonly ListedDecision[],
  signal: AbortSignal | undefined,
): Promise<IngestionResult[]> => {
  const decisions: IngestionResult[] = [];
  for (let start = 0; start < listed.length; start += DOCUMENT_CONCURRENCY) {
    const batch = listed.slice(start, start + DOCUMENT_CONCURRENCY);
    decisions.push(
      // oxlint-disable-next-line no-await-in-loop -- bounded batches pace the court while preserving result order
      ...(await Promise.all(
        batch.map(async (item) => await fetchListedDecision(item, signal)),
      )),
    );
    if (start + DOCUMENT_CONCURRENCY < listed.length) {
      // oxlint-disable-next-line no-await-in-loop -- deliberate pacing between bounded request batches
      await Bun.sleep(100);
    }
  }
  return decisions;
};

export const czUsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_US,
  name: "Czech Constitutional Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 100,
  // A page enumerates 40 exact publisher ids, then fetches decision/abstract
  // pairs in batches of five. Ten worst-case page timeouts remain below the
  // cycle budget, so caught-up cycles can complete and enter idle backoff.
  //
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
        const now = new Date();
        const state = cursor ? parseCursor(cursor) : historicalStart();
        const page = await fetchSearchPage(state, signal);
        if (page === null) {
          return {
            decisions: [],
            nextCursor: makeCursor(nextSlice(state, now)),
            coverage: {
              slice: coverageSlice(state),
              reported: 0,
              collected: 0,
            },
          };
        }

        const decisions = await fetchListedDecisions(page.listed, signal);
        const sliceComplete = page.rangeTo === page.reported;
        return {
          decisions,
          nextCursor: makeCursor(
            sliceComplete
              ? nextSlice(state, now)
              : { ...state, page: state.page + 1 },
          ),
          ...(sliceComplete
            ? {
                coverage: {
                  slice: coverageSlice(state),
                  reported: page.reported,
                  collected: page.rangeTo,
                },
              }
            : {}),
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_US, cursor),
    });
  },
};
