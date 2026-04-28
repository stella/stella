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
  isNullishArrayOf,
  isNullishOneOrArrayOf,
  isNullishString,
  isNullishValue,
  parseCeDate,
  stripHtml,
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseNsDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-ns";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";

const COMMON_HEADERS = {
  "User-Agent": INGESTION_USER_AGENT,
} as const;

/**
 * Czech Supreme Court adapter.
 *
 * The case law database lives on rozhodnuti.nsoud.cz (Lotus
 * Notes/Domino). Uses the ReadViewEntries JSON endpoint for
 * listing decisions, then fetches individual decision pages
 * for metadata (date, ECLI, legal sentence, keywords, etc.).
 *
 * Cursor format: position offset as string (e.g. "1", "21").
 * A null cursor starts from position 1.
 */

const BASE_URL = "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf";
const PAGE_SIZE = 40;

/** Domino ReadViewEntries JSON shape. */
type DominoViewEntry = {
  "@position"?: string | null;
  "@unid"?: string | null;
  entrydata?:
    | {
        "@name"?: string | null;
        text?: { "0"?: string | null } | null;
      }[]
    | null;
};

type DominoViewResponse = {
  "@toplevelentries"?: string | null;
  viewentry?: DominoViewEntry | DominoViewEntry[] | null;
};

const isDominoText = (
  value: unknown,
): value is { "0"?: string | null | undefined } =>
  isRecord(value) && isNullishString(value["0"]);

const isDominoEntryData = (
  value: unknown,
): value is {
  "@name"?: string | null;
  text?: { "0"?: string | null } | null;
} =>
  isRecord(value) &&
  isNullishString(value["@name"]) &&
  isNullishValue(value["text"], isDominoText);

const isDominoViewEntry = (value: unknown): value is DominoViewEntry =>
  isRecord(value) &&
  isNullishString(value["@position"]) &&
  isNullishString(value["@unid"]) &&
  isNullishArrayOf(value["entrydata"], isDominoEntryData);

const isDominoViewResponse = (value: unknown): value is DominoViewResponse =>
  isRecord(value) &&
  isNullishString(value["@toplevelentries"]) &&
  isNullishOneOrArrayOf(value["viewentry"], isDominoViewEntry);

const normalizeViewEntries = (
  viewentry: DominoViewResponse["viewentry"],
): DominoViewEntry[] =>
  viewentry === undefined || viewentry === null
    ? []
    : Array.isArray(viewentry)
      ? viewentry
      : [viewentry];

/** Extract a named field from Domino entrydata. */
const entryField = (
  entry: DominoViewEntry,
  name: string,
): string | undefined => {
  const field = entry.entrydata?.find((e) => e["@name"] === name);
  return toOptionalValue(field?.text?.["0"]);
};

/** Metadata label patterns on detail pages. */
const LABEL_PATTERNS: Record<string, RegExp> = {
  decisionDate:
    /Datum rozhodnutí:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>([\s\S]*?)<\/font>/i,
  ecli: /ECLI:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>([\s\S]*?)<\/font>/i,
  decisionType:
    /Typ rozhodnutí:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>([\s\S]*?)<\/font>/i,
  keywords:
    /Heslo:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>([\s\S]*?)<\/font>/i,
  statutes:
    /Dotčené předpisy:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>([\s\S]*?)<\/font>/i,
  category:
    /Kategorie rozhodnutí:<\/font><\/b><\/td><td[^>]*><b><font[^>]*>([\s\S]*?)<\/font>/i,
  legalSentence: /Právní věta:<\/font><\/b><\/td><td[^>]*>([\s\S]*?)<\/td>/i,
};

/**
 * Extract the presiding judge name from the decision text.
 *
 * NS decisions end with a signature block:
 *   "JUDr. Firstname Surname\npředseda/předsedkyně senátu"
 * We capture the name on the line immediately before the
 * "předseda/předsedkyně senátu" label.
 */
const JUDGE_RE =
  // oxlint-disable-next-line sonarjs/slow-regex -- signature extraction scans one bounded decision text
  /(?:JUDr\.|Mgr\.|doc\.|prof\.)\s+[\p{L}\s,.-]+?(?=\s*předsed[ay]\s+senátu)/iu;

const extractJudge = (text: string): string | undefined => {
  const match = JUDGE_RE.exec(text);
  if (!match) {
    return undefined;
  }
  return match[0].trim() || undefined;
};

/** Body text markers. */
const BODY_START_MARKERS = [
  "Nejvyšší soud rozhodl",
  "Nejvyšší soud České republiky",
  "Nejvyšší soud projednal",
];
const BODY_END_MARKER = "Citace rozhodnutí";

/** Extract decision fulltext from the detail page body. */
const extractFulltext = (html: string): string | undefined => {
  // Decision text is in <font face="Times New Roman"> tags
  const parts = html.match(
    /<font[^>]*face="Times New Roman"[^>]*>([\s\S]*?)<\/font>/gi,
  );
  if (!parts || parts.length === 0) {
    return undefined;
  }

  let text = stripHtml(parts.join(" ")).trim();

  // Trim metadata prefix — body starts at the decision header
  for (const marker of BODY_START_MARKERS) {
    const pos = text.indexOf(marker);
    if (pos > 0) {
      text = text.slice(pos);
      break;
    }
  }

  // Trim footer
  const endPos = text.indexOf(BODY_END_MARKER);
  if (endPos > 0) {
    text = text.slice(0, endPos).trim();
  }

  return text.length > 100 ? text : undefined;
};

/** Parse metadata from a decision detail page. */
const parseDetailPage = (html: string): Record<string, string | undefined> => {
  const result: Record<string, string | undefined> = {};

  for (const [key, pattern] of Object.entries(LABEL_PATTERNS)) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const text = stripHtml(match[1]).trim();
      if (text) {
        result[key] = text;
      }
    }
  }

  result["fulltext"] = extractFulltext(html);

  return result;
};

export const czNsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_NS,
  name: "Czech Supreme Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 200,
  // Each page fetches 40 decisions + detail pages. ~40s/page.
  // 15 pages ≈ 10 min (within MAX_CYCLE_MS).
  maxSyncPages: 15,

  async getTotalCount(signal) {
    try {
      const url =
        `${BASE_URL}/WebSearch?ReadViewEntries` +
        `&Count=1&Start=1&OutputFormat=JSON`;

      const response = await fetch(url, { signal, headers: COMMON_HEADERS });
      if (!response.ok) {
        return null;
      }

      const json = await response.json();
      if (!isDominoViewResponse(json)) {
        return null;
      }
      const raw = json["@toplevelentries"];
      if (!raw) {
        return null;
      }

      const parsed = Number.parseInt(raw, 10);
      return Number.isNaN(parsed) ? null : parsed;
    } catch {
      return null;
    }
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const start = cursor ? Number.parseInt(cursor, 10) : 1;

        const listUrl =
          `${BASE_URL}/WebSearch?ReadViewEntries` +
          `&Count=${PAGE_SIZE}` +
          `&Start=${start}` +
          `&OutputFormat=JSON`;

        const listResponse = await fetch(listUrl, {
          headers: COMMON_HEADERS,
          signal: signal
            ? AbortSignal.any([
                signal,
                AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
              ])
            : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
        });

        if (!listResponse.ok) {
          throw new AdapterFetchError({
            message: `CZ Supreme Court list error: ${listResponse.status}`,
            adapterKey: ADAPTER_KEYS.CZ_NS,
            cursor,
            httpStatus: listResponse.status,
          });
        }

        const json = await listResponse.json();
        if (!isDominoViewResponse(json)) {
          throw new AdapterFetchError({
            message: "CZ Supreme Court list returned an invalid payload",
            adapterKey: ADAPTER_KEYS.CZ_NS,
            cursor,
          });
        }
        const entries = normalizeViewEntries(json.viewentry);

        const decisions: IngestionResult[] = [];

        for (let i = 0; i < entries.length; i++) {
          const entry = entries.at(i);
          if (!entry) {
            continue;
          }
          const unid = entry["@unid"];
          const caseNumber = entryField(entry, "znacka");

          if (!unid || !caseNumber) {
            continue;
          }

          const webUrl = `${BASE_URL}/WebSearch/${unid}?openDocument`;
          const printUrl = `${BASE_URL}/WebPrint/${unid}?openDocument`;

          // Fetch detail + print pages in parallel
          try {
            const requestSignal = signal
              ? AbortSignal.any([
                  signal,
                  AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
                ])
              : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST);

            const [detailResponse, printResponse] = await Promise.all([
              fetch(webUrl, { signal: requestSignal, headers: COMMON_HEADERS }),
              fetch(printUrl, {
                signal: requestSignal,
                headers: COMMON_HEADERS,
              }),
            ]);

            if (detailResponse.ok) {
              const webHtml = await detailResponse.text();
              const printHtml = printResponse.ok
                ? await printResponse.text()
                : "";

              const meta = parseDetailPage(webHtml);
              const raw = `${caseNumber}|${meta["ecli"] ?? ""}|${meta["decisionDate"] ?? ""}`;

              // Parse AST from the print page (rich HTML)
              // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- AST container, not a DB update
              let documentAst: DocumentAst | EmptyAst = EMPTY_AST;
              let fulltext = meta["fulltext"];

              // eslint-disable-next-line no-untyped-updates/no-untyped-updates -- court API metadata container, not a DB update
              let sourceMetadata: Record<string, unknown> = {};

              if (printHtml) {
                const parsed = parseNsDecisionHtml({
                  documentId: unid,
                  webUrl,
                  printUrl,
                  webHtml,
                  printHtml,
                });
                documentAst = parsed.documentAst;
                fulltext = parsed.fulltext;
                sourceMetadata = parsed.sourceMetadata;
              }

              // Extract judge from fulltext signature block
              const judge = fulltext ? extractJudge(fulltext) : undefined;

              decisions.push({
                caseNumber,
                ecli: meta["ecli"],
                court: "Nejvyšší soud",
                country: "CZE",
                language: "cs",
                decisionDate: meta["decisionDate"]
                  ? parseCeDate(meta["decisionDate"])
                  : undefined,
                decisionType: meta["decisionType"]?.toLowerCase(),
                fulltext,
                sourceUrl: webUrl,
                documentUrl: webUrl,
                metadata: {
                  caseNumber,
                  ecli: meta["ecli"],
                  court: "Nejvyšší soud" as const,
                  decisionDate: meta["decisionDate"]
                    ? parseCeDate(meta["decisionDate"])
                    : undefined,
                  decisionType: meta["decisionType"]?.toLowerCase(),
                  ...sourceMetadata,
                  judge,
                  legalSentence: meta["legalSentence"],
                  keywords: meta["keywords"]
                    ?.split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  statutes: meta["statutes"]
                    ?.split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  category: meta["category"]?.trim(),
                },
                rawHash: hashContent(raw),
                parserVersion: PARSER_VERSION,
                documentAst,
                sourceRaw: JSON.stringify({ webHtml, printHtml }),
                sourceRawContentType: "text/html",
              });
            } else {
              // eslint-disable-next-line no-console -- adapter diagnostic
              console.warn(
                `CZ Supreme: detail fetch for ${unid} returned ${detailResponse.status}`,
              );
            }
          } catch (error) {
            // Caller cancelled: return partial results
            if (error instanceof DOMException && error.name === "AbortError") {
              return {
                decisions,
                nextCursor: String(start + i),
              };
            }
            // Timeout: distinguish page-level from per-entry
            if (
              error instanceof DOMException &&
              error.name === "TimeoutError"
            ) {
              // Page-level signal fired: return partial results
              if (signal?.aborted) {
                return {
                  decisions,
                  nextCursor: String(start + i),
                };
              }
              // Per-entry timeout: skip this entry
              continue;
            }
            throw error;
          }

          // Rate limit between detail fetches (skip for last entry)
          if (i < entries.length - 1) {
            await Bun.sleep(50);
          }
        }

        const totalEntries = json["@toplevelentries"]
          ? Number.parseInt(json["@toplevelentries"], 10)
          : undefined;

        const hasMore =
          totalEntries !== undefined
            ? start + entries.length <= totalEntries
            : entries.length >= PAGE_SIZE;

        // When exhausted, park the cursor one page back from the
        // end so the next cycle only re-checks recent entries for
        // new additions. Never return null — that restarts the
        // full scan from position 1.
        const nextCursor = hasMore
          ? String(start + entries.length)
          : String(Math.max(1, start + entries.length - PAGE_SIZE));

        return { decisions, nextCursor };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_NS, cursor),
    });
  },
};
