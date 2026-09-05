import { Result, panic } from "better-result";
import * as cheerio from "cheerio";

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
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
  parseCeDate,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseUsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-us";
import { errorTag } from "@/api/lib/errors/utils";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

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
 *
 * The same search form takes an arbitrary decision-date range, which is what
 * makes this source reconcilable: a decision year can be listed on its own,
 * without the crawl cursor ever reaching it. See `reconciliation` at the
 * bottom of this file.
 */

const ABSTRACT_URL = "https://nalus.usoud.cz/Search/GetAbstract.aspx";
const RESULT_DETAIL_URL = "https://nalus.usoud.cz/Search/ResultDetail.aspx";
const SEARCH_URL = "https://nalus.usoud.cz/Search/Search.aspx";
const RESULTS_URL = "https://nalus.usoud.cz/Search/Results.aspx";
const TEXT_URL = "https://nalus.usoud.cz/Search/GetText.aspx";

const persistableNalusComponent = (
  namespace: "nalus-record" | "nalus-sz" | "nalus-ecli",
  value: string | undefined,
): string | undefined =>
  value !== undefined &&
  value.length > 0 &&
  isPersistableSourceDocumentId(`${namespace}:${value}`)
    ? value
    : undefined;

const nalusIdentities = ({
  recordId,
  sz,
  ecli,
}: {
  recordId: string | undefined;
  sz: string | undefined;
  ecli: string | undefined;
}): {
  sourceDocumentId: string;
  aliases: readonly string[] | undefined;
} | null => {
  const identities = [
    recordId ? `nalus-record:${recordId}` : undefined,
    sz ? `nalus-sz:${sz}` : undefined,
    ecli ? `nalus-ecli:${ecli}` : undefined,
  ].filter(
    (identity): identity is string =>
      identity !== undefined && isPersistableSourceDocumentId(identity),
  );
  const sourceDocumentId = identities.at(0);
  if (sourceDocumentId === undefined) {
    return null;
  }
  const aliases = identities.slice(1);
  return {
    sourceDocumentId,
    aliases: aliases.length === 0 ? undefined : aliases,
  };
};

/** Largest result size that keeps one page's text fetches reasonably bounded. */
const RESULTS_PAGE_SIZE = 40;

/**
 * Result size for a listing walk, the largest the search form offers. The
 * crawl takes forty at a time because every row it keeps costs a text and an
 * abstract fetch; a listing walk fetches no documents, so it asks for the whole
 * eighty. NALUS honours it: a 2013 query answers `Výsledky 1 - 80 z celkem
 * 4345`, and `?page=1` answers `81 - 160`.
 */
const LISTING_PAGE_SIZE = 80;

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

const parseCounter = (raw: string | undefined): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const counter = Number.parseInt(raw, 10);
  return Number.isSafeInteger(counter) && counter > 0 ? counter : undefined;
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
  return parseCounter(counter);
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
  nalusRecordId: string | undefined;
  nalusSz: string | undefined;
  nalusQuarantineIds: readonly string[];
};

const parseDecisionPage = ({
  html,
  sourceUrl,
  sourceDocumentId,
  listedEcli,
  listedCounter,
  nalusRecordId,
  nalusSz,
  nalusQuarantineIds,
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
    sourceDocumentIdAliases: nalusIdentities({
      recordId: nalusRecordId,
      sz: nalusSz,
      ecli,
    })?.aliases,
    sourceDocumentIdRepairAliases: nalusQuarantineIds.map(
      (quarantineId) => `nalus-quarantine:${quarantineId}`,
    ),
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
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_US],
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

/**
 * One row of a NALUS result page, as {@link parseResultPage} reads it. This is
 * also the reconciliation payload: the loop parks it verbatim as JSON and
 * replays it through {@link buildCzUsFromPayload}, so every field the fetch
 * and the identity depend on has to live here rather than in the walk.
 */
export type ListedDecision = {
  caseNumber: string;
  counter?: number | undefined;
  identityQuarantined?: true | undefined;
  quarantineId: string;
  quarantineRepairIds: readonly string[];
  listingDocketMissing?: true | undefined;
  listingHtml: string;
  sourceDocumentId: string;
  nalusRecordId?: string | undefined;
  sourceUrl: string;
  sz?: string | undefined;
  ecli?: string | undefined;
};

/**
 * The identity the ingest would store for this listed record.
 *
 * `sourceDocumentId` is the whole rule, and it is minted once, in
 * {@link parseResultPage}: the exact publisher identity where the row exposes
 * one, the content-addressed quarantine identity where it exposes none. Every
 * decision this adapter writes — a parsed one, a listing-only one — carries
 * that same string, so reading it back here is what keeps the crawl, the
 * reconciliation loop and the ledger agreeing about which rows exist.
 *
 * `unidentifiable` is unreachable from a row {@link parseResultPage} built,
 * since both branches produce a persistable id. It is stated anyway because
 * the alternative is silence: an id the decision table would reject can never
 * be held, so counting it as missing would keep the slice short forever.
 */
export const czUsListingIdentity = (listed: ListedDecision): ListingIdentity =>
  isPersistableSourceDocumentId(listed.sourceDocumentId)
    ? { type: "document", sourceDocumentId: listed.sourceDocumentId }
    : { type: "unidentifiable" };

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
      state satisfies never;
      return panic(`Unhandled cz-us cursor: ${String(state)}`);
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
      state satisfies never;
      return panic(`Unhandled cz-us cursor: ${String(state)}`);
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

const hiddenField = (html: string, name: string): string | undefined =>
  cheerio.load(html)(`#${name}`).attr("value");

/**
 * Stable publisher-visible fields for an anomalous row that exposes neither
 * normal NALUS identity. Render position is deliberately absent: WebForms
 * alternates CSS classes and embeds `pos`/`cnt` in links, so hashing the row
 * markup would mint a new quarantine identity whenever result order moves.
 */
const quarantineFingerprint = ({
  stablePrimaryText,
  stableActionsText,
  stableDetailText,
  stableCounterText,
}: {
  stablePrimaryText: string;
  stableActionsText: string;
  stableDetailText: string;
  stableCounterText: string;
}): string => {
  const normalize = (value: string): string =>
    value.replace(/\s+/gu, " ").trim();
  return hashContent(
    JSON.stringify({
      stablePrimaryText: normalize(stablePrimaryText),
      stableActionsText: normalize(stableActionsText),
      stableDetailText: normalize(stableDetailText),
      stableCounterText: normalize(stableCounterText),
    }),
  );
};

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
      state satisfies never;
      return panic(`Unhandled cz-us cursor: ${String(state)}`);
    }
  }
};

type ParseResultPageOptions = {
  html: string;
  /** 0-indexed page the request asked for. */
  expectedPage: number;
  /** Rows per page the request asked for; the banner is read against it. */
  pageSize: number;
};

const parseResultPage = ({
  html,
  expectedPage,
  pageSize,
}: ParseResultPageOptions): SearchPage => {
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

  const expectedFrom = expectedPage * pageSize + 1;
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
    const detail = primary.find("a[href*='ResultDetail.aspx']").first();
    const detailHref = detail.attr("href");
    const nalusRecordId = persistableNalusComponent(
      "nalus-record",
      /[?&]id=(?<id>\d+)/u.exec(detailHref ?? "")?.groups?.["id"],
    );
    const actions = primary.next("tr");
    const linkAction = actions
      .find("[onclick*='GetText.aspx?sz=']")
      .first()
      .attr("onclick");
    const rawUrl =
      /ShowLink\("(?<url>https?:\/\/[^"]+GetText\.aspx\?sz=[^"]+)"/u.exec(
        linkAction ?? "",
      )?.groups?.["url"];
    let sz: string | undefined;
    if (rawUrl) {
      try {
        sz = persistableNalusComponent(
          "nalus-sz",
          new URL(rawUrl).searchParams.get("sz") || undefined,
        );
      } catch {
        // A malformed or withdrawn text action does not erase the stable
        // ResultDetail record identity exposed by the listing.
      }
    }
    const listingHtml = `${primary.toString()}${actions.toString()}`;
    const ecli = persistableNalusComponent(
      "nalus-ecli",
      /ECLI:CZ:US:[^<\s]+/u.exec(primary.html() ?? "")?.at(0),
    );
    const registrySign = detail.text();
    // The count banner says this is a publisher record even if a malformed or
    // withdrawn row exposes neither of NALUS's normal identities. Give that
    // terminal listing a content-addressed quarantine identity derived from
    // semantic fields so one poison row cannot pin the reconciliation slice.
    const exactPublisherIdentity = nalusIdentities({
      recordId: nalusRecordId,
      sz,
      ecli,
    });
    const counterText = /#(?<counter>\d+)\s*$/u.exec(registrySign)?.groups?.[
      "counter"
    ];
    const szCounter = /_(?<counter>\d+)$/u.exec(sz ?? "")?.groups?.["counter"];
    const listedCaseNumber = registrySign.replace(/#\d+\s*$/u, "").trim();
    // Compute the identity-less form for every row. If publisher links are
    // restored later, this becomes a migration alias for the earlier durable
    // quarantine row. Strip every identity-bearing control from the visible
    // text: the detail anchor, ECLI and retrieval action can all appear only
    // when identity metadata recovers, so none may participate in the repair
    // fingerprint.
    const stablePrimary = primary.clone();
    stablePrimary.find("a[href*='ResultDetail.aspx']").remove();
    const stablePrimaryText = stablePrimary.text().replace(ecli ?? "", "");
    const stableActions = actions.clone();
    stableActions
      .find("[onclick*='GetText.aspx?sz='], a[href*='GetText.aspx?sz=']")
      .remove();
    const stableFingerprintFields = {
      stablePrimaryText,
      stableActionsText: stableActions.text(),
    };
    const stableDetailTexts = [...new Set([listedCaseNumber, ""])];
    const stableCounterTexts = [
      ...new Set([counterText ?? szCounter ?? "", ""]),
    ];
    const quarantineRepairIds = stableDetailTexts.flatMap((stableDetailText) =>
      stableCounterTexts.map((stableCounterText) =>
        quarantineFingerprint({
          ...stableFingerprintFields,
          stableDetailText,
          stableCounterText,
        }),
      ),
    );
    const quarantineId =
      quarantineRepairIds[0] ?? panic("Missing quarantine id");
    const publisherIdentity = exactPublisherIdentity ?? {
      sourceDocumentId: `nalus-quarantine:${quarantineId}`,
      aliases: undefined,
    };
    const fallbackCaseNumber =
      exactPublisherIdentity !== null
        ? `NALUS record ${nalusRecordId ?? sz ?? ecli}`
        : `NALUS listing ${quarantineId}`;
    const caseNumber = listedCaseNumber || fallbackCaseNumber;
    const sourceDocumentId = publisherIdentity.sourceDocumentId;

    let sourceUrl: URL;
    if (sz !== undefined) {
      sourceUrl = new URL(TEXT_URL);
      sourceUrl.searchParams.set("sz", sz);
    } else if (nalusRecordId !== undefined) {
      sourceUrl = new URL(RESULT_DETAIL_URL);
      sourceUrl.searchParams.set("id", nalusRecordId);
    } else {
      sourceUrl = new URL(RESULTS_URL);
      sourceUrl.hash = `listing-${quarantineId}`;
    }
    listed.push({
      caseNumber,
      ...(listedCaseNumber ? {} : { listingDocketMissing: true }),
      counter: parseCounter(counterText ?? szCounter),
      sourceDocumentId,
      quarantineId,
      quarantineRepairIds,
      listingHtml,
      ...(exactPublisherIdentity === null ? { identityQuarantined: true } : {}),
      ...(nalusRecordId === undefined ? {} : { nalusRecordId }),
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

type FetchSearchPageOptions = {
  state: CursorState;
  pageSize: number;
  signal?: AbortSignal | undefined;
};

const fetchSearchPage = async ({
  state,
  pageSize,
  signal,
}: FetchSearchPageOptions): Promise<SearchPage | null> => {
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
    ctl00$MainContent$resultsPageSize: String(pageSize),
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
  return parseResultPage({
    html: await results.text(),
    expectedPage: state.page,
    pageSize,
  });
};

/**
 * What building one listed record produced.
 *
 * `detail-unavailable` still carries the decision the listing alone describes,
 * because the two callers dispose of it differently: the crawl's cursor moves
 * past this record either way, so a listing-only row is worth more to it than
 * nothing, while the reconciliation must refuse it — a detail-less row would
 * make the identity held and take the document out of every later
 * reconciliation.
 */
export type CzUsBuildResult =
  | { type: "built"; decision: IngestionResult }
  /** NALUS lists the record but serves no readable text for it. */
  | { type: "detail-unavailable"; decision: IngestionResult };

const fetchListedDecision = async (
  listed: ListedDecision,
  signal: AbortSignal | undefined,
): Promise<CzUsBuildResult> => {
  if (listed.identityQuarantined) {
    return {
      type: "detail-unavailable",
      decision: listedOnlyDecision(listed, "missing-record-identity"),
    };
  }
  if (listed.sz === undefined) {
    return {
      type: "detail-unavailable",
      decision: listedOnlyDecision(listed, "missing-text-action"),
    };
  }
  const response = await fetchWithTimeout(listed.sourceUrl, {
    headers: COMMON_HEADERS,
    redirect: "manual",
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      return {
        type: "detail-unavailable",
        decision: listedOnlyDecision(listed, `http-${response.status}`),
      };
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
    nalusQuarantineIds: listed.quarantineRepairIds,
  });
  if (!decision) {
    return {
      type: "detail-unavailable",
      decision: listedOnlyDecision(
        listed,
        "unparseable-detail",
        multiResponseSourceRaw({
          listingHtml: listed.listingHtml,
          textHtml: responseHtml,
        }),
      ),
    };
  }
  if (listed.listingDocketMissing) {
    decision.metadata["listingDocketMissing"] = true;
  }

  let abstractHtml: string | undefined;
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
      abstractHtml = await abstractResponse.text();
      const { abstract, legalSentence } = extractAbstract(abstractHtml);
      if (abstract) {
        decision.metadata["abstract"] = abstract;
      }
      if (legalSentence) {
        decision.metadata["legalSentence"] = legalSentence;
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // Abstracts are optional enrichment; the listed decision is complete
    // enough to ingest without one.
  }
  Object.assign(
    decision,
    multiResponseSourceRaw({
      listingHtml: listed.listingHtml,
      textHtml: responseHtml,
      abstractHtml,
    }),
  );
  return { type: "built", decision };
};

const multiResponseSourceRaw = ({
  listingHtml,
  textHtml,
  abstractHtml,
}: {
  listingHtml: string;
  textHtml: string;
  abstractHtml?: string | undefined;
}): { sourceRaw: string; sourceRawContentType: string } => ({
  sourceRaw: JSON.stringify({
    listingHtml,
    textHtml,
    ...(abstractHtml === undefined ? {} : { abstractHtml }),
  }),
  sourceRawContentType: "application/json",
});

const listedOnlyDecision = (
  listed: ListedDecision,
  reason: string,
  rawSource?: {
    sourceRaw: string;
    sourceRawContentType: string;
  },
): IngestionResult => ({
  caseNumber: listed.caseNumber,
  caseNumberIsPlaceholder: listed.listingDocketMissing === true,
  isListingOnly: true,
  sourceDocumentId: listed.sourceDocumentId,
  sourceDocumentIdAliases: nalusIdentities({
    recordId: listed.nalusRecordId,
    sz: listed.sz,
    ecli: listed.ecli,
  })?.aliases,
  sourceDocumentIdRepairAliases:
    listed.identityQuarantined === true
      ? undefined
      : listed.quarantineRepairIds.map(
          (quarantineId) => `nalus-quarantine:${quarantineId}`,
        ),
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
    ...(listed.nalusRecordId === undefined
      ? {}
      : { nalusRecordId: listed.nalusRecordId }),
    nalusSz: listed.sz,
    listingDocketMissing: listed.listingDocketMissing,
    identityQuarantined: listed.identityQuarantined,
    ecliCounter: listed.counter,
    listedOnly: true,
    listedOnlyReason: reason,
  },
  rawHash: hashContent(
    `${listed.sourceDocumentId}|${listed.caseNumber}|listed-only|${reason}`,
  ),
  parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_US],
  documentAst: EMPTY_AST,
  sourceRaw: rawSource?.sourceRaw ?? listed.listingHtml,
  sourceRawContentType: rawSource?.sourceRawContentType ?? "text/html",
});

const fetchListedDecisions = async (
  listed: readonly ListedDecision[],
  signal: AbortSignal | undefined,
): Promise<IngestionResult[]> => {
  const decisions: IngestionResult[] = [];
  for (let start = 0; start < listed.length; start += DOCUMENT_CONCURRENCY) {
    const batch = listed.slice(start, start + DOCUMENT_CONCURRENCY);
    decisions.push(
      // The crawl keeps a listing-only row for a record NALUS serves no text
      // for: its cursor moves past that record either way, so the observation
      // is worth more than nothing. Only the reconciliation refuses it.
      ...(await Promise.all(
        batch.map(
          async (item) => (await fetchListedDecision(item, signal)).decision,
        ),
      )),
    );
    if (start + DOCUMENT_CONCURRENCY < listed.length) {
      await Bun.sleep(100);
    }
  }
  return decisions;
};

// ── Reconciliation ───────────────────────────────────────

/**
 * A reconciliation slice is one decision year, `YYYY`, which is exactly what
 * the search form's `decidedFrom`/`decidedTo` pair addresses and what the
 * crawl's historical phase already walks. Four digits sort lexicographically
 * in chronological order, which is the ordering the ledger relies on.
 *
 * The year rather than a finer unit because NALUS states a total for whatever
 * range it is asked about, and a year is comfortably walkable: the court's
 * busiest years are around four thousand decisions (4,345 decided in 2013), so
 * a slice is roughly 55 pages of {@link LISTING_PAGE_SIZE} against the engine's
 * 200-page ceiling. A month would triple the request count to prove the same
 * thing, and the court sits few enough days that most days would be empty.
 */
const CZ_US_FIRST_SLICE = String(FIRST_YEAR);

const SLICE_PATTERN = /^\d{4}$/u;

const parseSlice = (slice: string): number => {
  if (!SLICE_PATTERN.test(slice)) {
    panic(`cz-us slice is not a decision year: ${slice}`);
  }
  return Number.parseInt(slice, 10);
};

const czUsSliceOf = (now: Date): string => String(now.getUTCFullYear());

const czUsNextSlice = (slice: string): string | null => {
  const next = parseSlice(slice) + 1;
  return next > new Date().getUTCFullYear() ? null : String(next);
};

const czUsPreviousSlice = (slice: string): string | null => {
  const previous = parseSlice(slice) - 1;
  return previous < FIRST_YEAR ? null : String(previous);
};

/**
 * Slices near the tip that get re-walked on a fast cadence. The contract
 * counts slices, not days, so for this adapter the window is two years: the
 * current one and the one before it.
 *
 * Two rather than one because a decision made in December is often released
 * the following spring, so on any January day the year that still gains
 * documents is last year's. A slice outside the window is re-walked only when
 * the ledger already recorded it short, which is exactly what a completed
 * older year is not.
 */
const CZ_US_TIP_WINDOW_SLICES = 2;

/**
 * One page of the publisher's own listing for a decision year, with no text or
 * abstract fetches.
 *
 * The availability filter is pinned to the latest closed publication day, the
 * same bound the crawl uses: NALUS keeps the current day's result set live, so
 * a walk that included it would list rows that move underneath it.
 *
 * A failed request is thrown, never flattened into an empty page. The crawl
 * can afford to read a dead search as "nothing here" because a cursor that
 * moves on can be walked again; a ledger row cannot, since an outage recorded
 * as an empty year makes that year settled and it is never revisited. So only
 * the publisher's own stated-empty answer — the no-records message with the
 * results button disabled, which {@link fetchSearchPage} alone returns `null`
 * for — is an empty slice. A missing count banner, a 5xx, a page that moved
 * underneath the request: all throw, and the engine retries on a later pass.
 */
const listCzUsSlicePage = async ({
  slice,
  page,
  signal,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const listing = await fetchSearchPage({
    state: {
      phase: SWEEP_PHASE.HISTORICAL,
      availableTo: latestClosedAvailabilityDay(new Date()),
      year: parseSlice(slice),
      pass: CRAWL_PASS.COLLECT,
      page,
      digest: DIGEST_SEED,
    },
    pageSize: LISTING_PAGE_SIZE,
    signal,
  });
  if (listing === null) {
    return { items: [], totalPages: 0 };
  }
  return {
    items: listing.listed.map((listed) => ({
      identity: czUsListingIdentity(listed),
      payload: listed,
    })),
    totalPages: Math.ceil(listing.reported / LISTING_PAGE_SIZE),
  };
};

/**
 * Validate a payload the loop stored verbatim.
 *
 * Revalidated rather than trusted: it may have been parked for days, and a
 * shape this adapter no longer produces has to be reported as unbuildable
 * instead of replayed on faith. Every field {@link fetchListedDecision} reads
 * is checked, because a payload missing one of them would otherwise fetch the
 * wrong document or mint a different identity than the walk keyed it under.
 */
const isListedDecision = (value: unknown): value is ListedDecision => {
  if (!isRecord(value)) {
    return false;
  }
  // Field names are typed against `ListedDecision`, so renaming one here is a
  // typecheck failure rather than a guard that silently stops checking it.
  const isString = (field: keyof ListedDecision): boolean =>
    typeof value[field] === "string";
  const isOptionalString = (field: keyof ListedDecision): boolean =>
    value[field] === undefined || isString(field);
  const isOptionalTrue = (field: keyof ListedDecision): boolean =>
    value[field] === undefined || value[field] === true;
  return (
    isString("caseNumber") &&
    isString("sourceDocumentId") &&
    isString("quarantineId") &&
    isString("listingHtml") &&
    isString("sourceUrl") &&
    isUnknownArray(value["quarantineRepairIds"]) &&
    value["quarantineRepairIds"].every((id) => typeof id === "string") &&
    (value["counter"] === undefined || typeof value["counter"] === "number") &&
    isOptionalString("nalusRecordId") &&
    isOptionalString("sz") &&
    isOptionalString("ecli") &&
    isOptionalTrue("identityQuarantined") &&
    isOptionalTrue("listingDocketMissing")
  );
};

/**
 * Replay one listed record through the adapter's own fetch and parse path.
 *
 * A record the listing names but whose text NALUS does not serve is reported,
 * not stored: the listing-only row {@link fetchListedDecision} still builds is
 * right for the crawl and wrong here, because writing it would make the
 * identity held and take the document out of every later reconciliation.
 */
const buildCzUsFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (
    !isListedDecision(payload) ||
    czUsListingIdentity(payload).type === "unidentifiable"
  ) {
    return { type: "unkeyable" };
  }
  const built = await fetchListedDecision(payload, signal);
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "detail-unavailable":
      return { type: "detail-unavailable" };
    default: {
      built satisfies never;
      return panic(`Unhandled cz-us build result: ${JSON.stringify(built)}`);
    }
  }
};

// ── Adapter ──────────────────────────────────────────────

export const czUsAdapter = defineSourceAdapter({
  key: ADAPTER_KEYS.CZ_US,
  name: "Czech Constitutional Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 100,
  // A page performs three serial search requests, then up to eight batches
  // whose detail and abstract requests are sequential. At the request-level
  // timeout that is about 190 seconds; the page budget leaves transport
  // margin, while maxCycleMs still bounds how many slow pages one cycle runs.
  //
  pageTimeoutMs: 240_000,
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
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
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
        return sourceTotalProbeFailed(
          SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD,
        );
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
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
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
        return sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
      }
      const total = /z celkem (?<n>\d+)/u.exec(await results.text())?.groups?.[
        "n"
      ];
      return total === undefined
        ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD)
        : sourceTotalRead(Number.parseInt(total, 10));
    } catch (error) {
      return { type: "probe-failed", errorTag: errorTag(error) };
    }
  },

  /**
   * The search form answers a decision-date range on its own, so what a year
   * holds is answerable without the crawl cursor ever reaching it: list the
   * year, key each record the way the ingest would, and compare against what
   * is held. This loop is the only writer of coverage for this source.
   */
  reconciliation: {
    firstSlice: CZ_US_FIRST_SLICE,
    sliceOf: czUsSliceOf,
    nextSlice: czUsNextSlice,
    previousSlice: czUsPreviousSlice,
    tipWindowDays: CZ_US_TIP_WINDOW_SLICES,
    // The crawl keeps the row `listedOnlyDecision` builds when NALUS serves no
    // readable text, and marks it `isListingOnly`; unset, that stub would count
    // as held and its document would never be hunted again. This source stores
    // whole decisions by design, so a detail-less row here is always a failed
    // fetch rather than a legitimate metadata-only state.
    heldRequiresDetail: true,
    listSlicePage: listCzUsSlicePage,
    buildDecision: buildCzUsFromPayload,
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const now = new Date();
        const state = cursor ? parseCursor(cursor, now) : historicalStart(now);
        let page: SearchPage | null;
        try {
          page = await fetchSearchPage({
            state,
            pageSize: RESULTS_PAGE_SIZE,
            signal,
          });
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
          };
        }

        const decisions = await fetchListedDecisions(page.listed, signal);
        if (sliceComplete) {
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
          nextCursor: makeCursor({
            ...state,
            page: state.page + 1,
            digest,
          }),
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_US, cursor),
    });
  },
});
