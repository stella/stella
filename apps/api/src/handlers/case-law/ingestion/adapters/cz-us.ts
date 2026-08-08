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
 * identifier and its internal record id. The record id is the canonical
 * document identity; the text identifier is an optional retrieval action.
 *
 * Never reconstruct a GetText identifier from a docket. Historical NALUS
 * identifiers use a different grammar, chamber numbering was not globally
 * sequential, plenary dockets overlap chamber numbers, and one docket can
 * publish several decisions. Probing `I-{number}-{year}_1` loses all of those
 * distinctions.
 *
 * Cursor formats:
 *   search:historical:<available-to>:<decision-year>:<pass>:<page>:<digest>:<expected>
 *   search:recent:<available-from>:<available-to>:<pass>:<page>:<digest>:<expected>
 *
 * A null or legacy probe cursor starts the search-based historical repair at
 * FIRST_YEAR. This intentionally re-enumerates history once: it migrates the
 * incomplete probe crawl onto publisher-stated document identities.
 */

const ABSTRACT_URL = "https://nalus.usoud.cz/Search/GetAbstract.aspx";
const RESULT_DETAIL_URL = "https://nalus.usoud.cz/Search/ResultDetail.aspx";
const SEARCH_URL = "https://nalus.usoud.cz/Search/Search.aspx";
const RESULTS_URL = "https://nalus.usoud.cz/Search/Results.aspx";
const TEXT_URL = "https://nalus.usoud.cz/Search/GetText.aspx";

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

const CRAWL_PASS = {
  COLLECT: "collect",
  VERIFY: "verify",
} as const;

type CrawlPass = (typeof CRAWL_PASS)[keyof typeof CRAWL_PASS];

/** Seed for the rolling identity digest stored in the cursor. */
const DIGEST_SEED = "0";

const NO_RESULTS_MESSAGE = "Pro zadaná kritéria nebyly nalezeny žádné záznamy.";

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

const parseCaseNumberComponents = (
  caseNumber: string,
): { senate: string; caseIndex: string; shortYear: string } | undefined => {
  const { senate, caseIndex, shortYear } =
    /^(?<senate>[IVX]+|Pl)\.ÚS\s+(?<caseIndex>\d+)\/(?<shortYear>\d+)$/u.exec(
      caseNumber,
    )?.groups ?? {};
  return senate && caseIndex && shortYear
    ? { senate, caseIndex, shortYear }
    : undefined;
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
  const components = parseCaseNumberComponents(caseNumber);
  if (!components) {
    return undefined;
  }
  const { senate, caseIndex, shortYear } = components;
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

/** URL identity emitted by the pre-search adapter for counter-one records. */
const legacySourceUrlsFor = (
  caseNumber: string,
  counter: number | undefined,
  nalusSz: string | undefined,
): readonly string[] | undefined => {
  if (counter !== 1) {
    return undefined;
  }
  const components = parseCaseNumberComponents(caseNumber);
  if (!components) {
    return undefined;
  }
  const legacyYear = String(
    Number.parseInt(components.shortYear, 10) % 100,
  ).padStart(2, "0");
  const legacySz = `I-${components.caseIndex}-${legacyYear}_1`;
  // The old probe always requested an I-prefixed URL, but NALUS can map
  // that guessed URL to a different chamber/plenary docket with the same
  // visible number. It is an adoption alias only when the listing exposes
  // that exact retrieval identity for this exact publisher record.
  if (nalusSz !== legacySz) {
    return undefined;
  }
  return [`https://nalus.usoud.cz/Search/GetText.aspx?sz=${legacySz}`];
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

type ParseDecisionPageOptions = {
  html: string;
  sourceUrl: string;
  sourceDocumentId: string;
  listedEcli: string | undefined;
  listedCounter: number | undefined;
  nalusRecordId: string;
  nalusSz: string | undefined;
};

const parseDecisionPage = ({
  html,
  sourceUrl,
  sourceDocumentId,
  listedEcli,
  listedCounter,
  nalusRecordId,
  nalusSz,
}: ParseDecisionPageOptions): IngestionResult | null => {
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
  const ecliCounter = extractEcliCounter(html) ?? listedCounter;
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
    legacySourceUrls: legacySourceUrlsFor(
      parsed.caseNumber,
      ecliCounter,
      nalusSz,
    ),
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
      nalusSz,
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
  availableTo: string;
  year: number;
  pass: CrawlPass;
  page: number;
  digest: string;
  expectedDigest?: string | undefined;
};

type RecentCursor = {
  phase: typeof SWEEP_PHASE.RECENT;
  availableFrom: string;
  availableTo: string;
  pass: CrawlPass;
  page: number;
  digest: string;
  expectedDigest?: string | undefined;
};

type CursorState = HistoricalCursor | RecentCursor;

type ListedDecision = {
  caseNumber: string;
  counter?: number | undefined;
  listingDocketMissing?: true | undefined;
  sourceDocumentId: string;
  nalusRecordId: string;
  sourceUrl: string;
  sz?: string | undefined;
  ecli?: string | undefined;
};

type SearchPage = {
  listed: ListedDecision[];
  rangeFrom: number;
  rangeTo: number;
  reported: number;
};

class SearchPageDriftError extends TypeError {
  override name = "SearchPageDriftError";
}

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const LEGACY_CURSOR_PATTERN = /^\d+:\d{4}(?::(?:historical|recent))?$/u;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Latest complete NALUS publication day; today's result set is still live. */
const latestClosedAvailabilityDay = (now: Date): string => {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - 1);
  return isoDay(date);
};

const historicalStart = (now: Date): HistoricalCursor => ({
  phase: SWEEP_PHASE.HISTORICAL,
  availableTo: latestClosedAvailabilityDay(now),
  year: FIRST_YEAR,
  pass: CRAWL_PASS.COLLECT,
  page: 0,
  digest: DIGEST_SEED,
});

const czechDate = (date: Date): string =>
  `${date.getUTCDate()}.${date.getUTCMonth() + 1}.${date.getUTCFullYear()}`;

const recentStart = (now: Date): RecentCursor => {
  const latest = latestClosedAvailabilityDay(now);
  const from = new Date(`${latest}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - RECENT_WINDOW_DAYS + 1);
  return {
    phase: SWEEP_PHASE.RECENT,
    availableFrom: isoDay(from),
    availableTo: latest,
    pass: CRAWL_PASS.COLLECT,
    page: 0,
    digest: DIGEST_SEED,
  };
};

const addUtcDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
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

const parseCursor = (cursor: string, now: Date): CursorState => {
  // The old probe cursor cannot be translated faithfully: it says which
  // guessed number came next, not which publisher documents were covered.
  // Restart the one-time publisher enumeration to repair that uncertainty.
  if (LEGACY_CURSOR_PATTERN.test(cursor)) {
    return historicalStart(now);
  }

  const parts = cursor.split(":");
  if (parts.at(0) !== "search") {
    throw new TypeError("Invalid cz-us cursor version");
  }

  const phase = parts.at(1);
  if (phase === SWEEP_PHASE.HISTORICAL && parts.length === 8) {
    const availableTo = parts.at(2);
    const year = parseNonNegativeInteger(parts.at(3), "year");
    if (year < FIRST_YEAR) {
      throw new TypeError("Invalid cz-us cursor year");
    }
    const pass = parts.at(4);
    const digest = parts.at(6);
    const expectedDigest = parts.at(7);
    if (
      !availableTo ||
      !ISO_DAY_PATTERN.test(availableTo) ||
      availableTo > latestClosedAvailabilityDay(now) ||
      (pass !== CRAWL_PASS.COLLECT && pass !== CRAWL_PASS.VERIFY) ||
      !digest ||
      (pass === CRAWL_PASS.VERIFY &&
        (!expectedDigest || expectedDigest === "-")) ||
      (pass === CRAWL_PASS.COLLECT && expectedDigest !== "-")
    ) {
      throw new TypeError("Invalid cz-us historical pass");
    }
    return {
      phase,
      availableTo,
      year,
      pass,
      page: parseNonNegativeInteger(parts.at(5), "page"),
      digest,
      ...(expectedDigest === "-" ? {} : { expectedDigest }),
    };
  }
  if (phase === SWEEP_PHASE.RECENT && parts.length === 8) {
    const availableFrom = parts.at(2);
    const availableTo = parts.at(3);
    const pass = parts.at(4);
    const digest = parts.at(6);
    const expectedDigest = parts.at(7);
    if (
      !availableFrom ||
      !availableTo ||
      !ISO_DAY_PATTERN.test(availableFrom) ||
      !ISO_DAY_PATTERN.test(availableTo) ||
      availableFrom > availableTo ||
      availableTo > latestClosedAvailabilityDay(now) ||
      (pass !== CRAWL_PASS.COLLECT && pass !== CRAWL_PASS.VERIFY) ||
      !digest ||
      (pass === CRAWL_PASS.VERIFY &&
        (!expectedDigest || expectedDigest === "-")) ||
      (pass === CRAWL_PASS.COLLECT && expectedDigest !== "-")
    ) {
      throw new TypeError("Invalid cz-us availability window");
    }
    return {
      phase,
      availableFrom,
      availableTo,
      pass,
      page: parseNonNegativeInteger(parts.at(5), "page"),
      digest,
      ...(expectedDigest === "-" ? {} : { expectedDigest }),
    };
  }
  throw new TypeError("Invalid cz-us cursor phase");
};

const makeCursor = (state: CursorState): string => {
  switch (state.phase) {
    case SWEEP_PHASE.HISTORICAL:
      return `search:${state.phase}:${state.availableTo}:${state.year}:${state.pass}:${state.page}:${state.digest}:${state.expectedDigest ?? "-"}`;
    case SWEEP_PHASE.RECENT:
      return `search:${state.phase}:${state.availableFrom}:${state.availableTo}:${state.pass}:${state.page}:${state.digest}:${state.expectedDigest ?? "-"}`;
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
        ? {
            phase: state.phase,
            availableTo: state.availableTo,
            year: state.year + 1,
            pass: CRAWL_PASS.COLLECT,
            page: 0,
            digest: DIGEST_SEED,
          }
        : nextRecentWindow(state.availableTo, now);
    case SWEEP_PHASE.RECENT: {
      return nextRecentWindow(state.availableTo, now);
    }
    default: {
      const unhandled: never = state;
      return panic(`Unhandled cz-us cursor: ${String(unhandled)}`);
    }
  }
};

function nextRecentWindow(availableTo: string, now: Date): RecentCursor {
  const latest = latestClosedAvailabilityDay(now);
  if (availableTo < latest) {
    const availableFrom = addUtcDays(availableTo, 1);
    return {
      phase: SWEEP_PHASE.RECENT,
      availableFrom,
      availableTo:
        [addUtcDays(availableFrom, RECENT_WINDOW_DAYS - 1), latest]
          .sort()
          .at(0) ?? latest,
      pass: CRAWL_PASS.COLLECT,
      page: 0,
      digest: DIGEST_SEED,
    };
  }
  return recentStart(now);
}

const restartSlice = (state: CursorState): CursorState => ({
  ...state,
  pass: CRAWL_PASS.COLLECT,
  page: 0,
  digest: DIGEST_SEED,
  expectedDigest: undefined,
});

const rollingPageDigest = (digest: string, page: SearchPage): string =>
  hashContent(
    `${digest}|${page.reported}|${page.listed
      .map(({ sourceDocumentId }) => sourceDocumentId)
      .join("|")}`,
  );

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
        ctl00$MainContent$availableFrom: "1.1.1900",
        ctl00$MainContent$availableTo: czechDate(
          new Date(`${state.availableTo}T00:00:00Z`),
        ),
        ctl00$MainContent$razeni: "20",
      };
    case SWEEP_PHASE.RECENT:
      return {
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
  if (banner.rangeFrom !== expectedFrom) {
    throw new SearchPageDriftError("NALUS result page moved during traversal");
  }
  if (banner.rangeTo > banner.reported) {
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
    if (!nalusRecordId) {
      throw new TypeError("NALUS result row is missing its record identity");
    }
    let sz: string | undefined;
    if (rawUrl) {
      try {
        sz = new URL(rawUrl).searchParams.get("sz") ?? undefined;
      } catch {
        // A malformed or withdrawn text action does not erase the stable
        // ResultDetail record identity exposed by the listing.
      }
    }
    const ecli = /ECLI:CZ:US:[^<\s]+/u.exec(primary.html() ?? "")?.at(0);
    const registrySign = detail.text();
    const counterText = /#(?<counter>\d+)\s*$/u.exec(registrySign)?.groups?.[
      "counter"
    ];
    const szCounter = /_(?<counter>\d+)$/u.exec(sz ?? "")?.groups?.["counter"];
    const listedCaseNumber = registrySign.replace(/#\d+\s*$/u, "").trim();
    const caseNumber = listedCaseNumber || `NALUS record ${nalusRecordId}`;
    const sourceUrl = new URL(sz ? TEXT_URL : RESULT_DETAIL_URL);
    sourceUrl.searchParams.set(sz ? "sz" : "id", sz ?? nalusRecordId);
    listed.push({
      caseNumber,
      ...(listedCaseNumber ? {} : { listingDocketMissing: true }),
      counter:
        counterText === undefined && szCounter === undefined
          ? 1
          : Number.parseInt(counterText ?? szCounter ?? "1", 10),
      sourceDocumentId: `nalus-record:${nalusRecordId}`,
      nalusRecordId,
      sourceUrl: sourceUrl.href,
      ...(sz === undefined ? {} : { sz }),
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
    redirect: "manual",
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
      const $ = cheerio.load(await submit.text());
      const noResults = $("#ctl00_MainContent_lbError").text().trim();
      const resultsDisabled =
        $("#ctl00_bResults").attr("disabled") === "disabled";
      if (noResults === NO_RESULTS_MESSAGE && resultsDisabled) {
        return null;
      }
      throw new TypeError("NALUS search did not confirm an empty result set");
    }
    throw new TypeError(`NALUS search returned HTTP ${submit.status}`);
  }

  const cookies = cookieHeader([first, submit]);
  const pageUrl =
    state.page === 0 ? RESULTS_URL : `${RESULTS_URL}?page=${state.page}`;
  const results = await fetchWithTimeout(pageUrl, {
    headers: { ...COMMON_HEADERS, Cookie: cookies },
    redirect: "manual",
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
  if (listed.sz === undefined) {
    return listedOnlyDecision(listed, "missing-text-action");
  }
  const response = await fetchWithTimeout(listed.sourceUrl, {
    headers: COMMON_HEADERS,
    redirect: "manual",
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      return listedOnlyDecision(listed, `http-${response.status}`);
    }
    throw new TypeError(
      `NALUS decision ${listed.sourceDocumentId} returned HTTP ${response.status}`,
    );
  }
  const responseHtml = await response.text();
  const decision = parseDecisionPage({
    html: responseHtml,
    sourceUrl: listed.sourceUrl,
    sourceDocumentId: listed.sourceDocumentId,
    listedEcli: listed.ecli,
    listedCounter: listed.counter,
    nalusRecordId: listed.nalusRecordId,
    nalusSz: listed.sz,
  });
  if (!decision) {
    return listedOnlyDecision(listed, "unparseable-detail", responseHtml);
  }
  if (listed.listingDocketMissing) {
    decision.metadata["listingDocketMissing"] = true;
  }

  try {
    const abstractQuery = new URLSearchParams({ sz: listed.sz });
    const abstractResponse = await fetchWithTimeout(
      `${ABSTRACT_URL}?${abstractQuery.toString()}`,
      {
        headers: COMMON_HEADERS,
        redirect: "manual",
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

const listedOnlyDecision = (
  listed: ListedDecision,
  reason: string,
  sourceRaw?: string,
): IngestionResult => ({
  caseNumber: listed.caseNumber,
  sourceDocumentId: listed.sourceDocumentId,
  legacySourceUrls: legacySourceUrlsFor(
    listed.caseNumber,
    listed.counter,
    listed.sz,
  ),
  ecli: listed.ecli,
  court: "Ústavní soud",
  country: "CZE",
  language: "cs",
  sourceUrl: listed.sourceUrl,
  metadata: {
    caseNumber: listed.caseNumber,
    ecli: listed.ecli,
    court: "Ústavní soud",
    nalusRecordId: listed.nalusRecordId,
    nalusSz: listed.sz,
    listingDocketMissing: listed.listingDocketMissing,
    listedOnly: true,
    listedOnlyReason: reason,
  },
  rawHash: hashContent(
    `${listed.sourceDocumentId}|${listed.caseNumber}|listed-only|${reason}`,
  ),
  parserVersion: PARSER_VERSION,
  documentAst: EMPTY_AST,
  sourceRaw,
  ...(sourceRaw === undefined ? {} : { sourceRawContentType: "text/html" }),
});

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
        redirect: "manual",
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
          redirect: "manual",
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
        const state = cursor ? parseCursor(cursor, now) : historicalStart(now);
        let page: SearchPage | null;
        try {
          page = await fetchSearchPage(state, signal);
        } catch (error) {
          if (state.page > 0 && error instanceof SearchPageDriftError) {
            return {
              decisions: [],
              nextCursor: makeCursor(restartSlice(state)),
            };
          }
          throw error;
        }
        if (page === null) {
          if (state.pass === CRAWL_PASS.VERIFY) {
            return {
              decisions: [],
              nextCursor: makeCursor(restartSlice(state)),
            };
          }
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

        const digest = rollingPageDigest(state.digest, page);
        const sliceComplete = page.rangeTo === page.reported;
        if (state.pass === CRAWL_PASS.VERIFY) {
          if (!sliceComplete) {
            return {
              decisions: [],
              nextCursor: makeCursor({
                ...state,
                page: state.page + 1,
                digest,
              }),
            };
          }
          if (digest !== state.expectedDigest) {
            return {
              decisions: [],
              nextCursor: makeCursor(restartSlice(state)),
            };
          }
          return {
            decisions: [],
            nextCursor: makeCursor(nextSlice(state, now)),
            coverage: {
              slice: coverageSlice(state),
              reported: page.reported,
              collected: page.reported,
            },
          };
        }

        const decisions = await fetchListedDecisions(page.listed, signal);
        if (sliceComplete && state.page > 0) {
          return {
            decisions,
            nextCursor: makeCursor({
              ...state,
              pass: CRAWL_PASS.VERIFY,
              page: 0,
              digest: DIGEST_SEED,
              expectedDigest: digest,
            }),
          };
        }
        return {
          decisions,
          nextCursor: makeCursor(
            sliceComplete
              ? nextSlice(state, now)
              : { ...state, page: state.page + 1, digest },
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
