import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";

/**
 * Czech Supreme Court adapter.
 *
 * Scrapes decisions from nsoud.cz using position-based
 * pagination (15 items per page). The site returns HTML which
 * we parse to extract decision metadata and fulltext links.
 *
 * Cursor format: page number as string (e.g. "0", "15", "30").
 */

const BASE_URL = "https://nsoud.cz/Judikatura/judikatura_ns.nsf";
const PAGE_SIZE = 15;

const hashResult = (input: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
};

/**
 * Extract text content from an HTML element-like string.
 * Simple extraction without a full DOM parser.
 */
const stripHtml = (html: string): string => html.replace(/<[^>]*>/g, "").trim();

// Top-level regex patterns (useTopLevelRegex)
const ENTRY_PATTERN =
  /<tr[^>]*class="[^"]*judikatura[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
const CASE_NUM_PATTERN = /sp\.\s*zn\.\s*([\w\s/]+)/i;
const DATE_PATTERN = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/;
const SENTENCE_PATTERN = /Právní\s+věta[^:]*:\s*([\s\S]*?)(?=<\/td|$)/i;
const LINK_PATTERN = /href="([^"]*WebSearch[^"]*)"/i;

/**
 * Parse the nsoud.cz search result HTML page to extract
 * decision entries. Each entry contains case number, date,
 * legal sentence, and a link to the full decision.
 */
type ParseResult = {
  decisions: IngestionResult[];
  rawEntryCount: number;
};

const parseSearchResults = (html: string): ParseResult => {
  const decisions: IngestionResult[] = [];
  let rawEntryCount = 0;

  // Reset global pattern
  ENTRY_PATTERN.lastIndex = 0;

  for (
    let entryMatch = ENTRY_PATTERN.exec(html);
    entryMatch !== null;
    entryMatch = ENTRY_PATTERN.exec(html)
  ) {
    rawEntryCount++;
    const block = entryMatch[1];

    const caseNumMatch = block.match(CASE_NUM_PATTERN);
    if (!caseNumMatch) {
      continue;
    }

    const caseNumber = caseNumMatch[1].trim();

    const dateMatch = block.match(DATE_PATTERN);
    const decisionDate = dateMatch
      ? `${dateMatch[3]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[1].padStart(2, "0")}`
      : undefined;

    const sentenceMatch = block.match(SENTENCE_PATTERN);
    const legalSentence = sentenceMatch
      ? stripHtml(sentenceMatch[1])
      : undefined;

    const linkMatch = block.match(LINK_PATTERN);
    const sourceUrl = linkMatch ? `${BASE_URL}/${linkMatch[1]}` : undefined;

    const raw = `${caseNumber}|${decisionDate}|${legalSentence}`;

    decisions.push({
      caseNumber,
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      decisionDate,
      sourceUrl,
      metadata: {
        legalSentence,
      },
      rawHash: hashResult(raw),
    });
  }

  return { decisions, rawEntryCount };
};

export const czSupremeAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_SUPREME,
  name: "Czech Supreme Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 2000,

  async fetchPage(cursor, _config, signal): Promise<SyncPage> {
    const start = cursor ? Number.parseInt(cursor, 10) : 0;

    const url = `${BASE_URL}/WebSearch?SearchOrder=4&Start=${start}&Count=${PAGE_SIZE}`;

    const response = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`CZ Supreme Court error: ${response.status}`);
    }

    const html = await response.text();
    const { decisions, rawEntryCount } = parseSearchResults(html);

    const nextCursor =
      rawEntryCount >= PAGE_SIZE ? String(start + PAGE_SIZE) : null;

    return { decisions, nextCursor };
  },
};
