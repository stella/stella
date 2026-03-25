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
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

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
const PAGE_SIZE = 20;

/** Domino ReadViewEntries JSON shape. */
type DominoViewEntry = {
  "@position"?: string;
  "@unid"?: string;
  entrydata?: {
    "@name"?: string;
    text?: { "0"?: string };
  }[];
};

type DominoViewResponse = {
  "@toplevelentries"?: string;
  viewentry?: DominoViewEntry[];
};

/** Extract a named field from Domino entrydata. */
const entryField = (
  entry: DominoViewEntry,
  name: string,
): string | undefined => {
  const field = entry.entrydata?.find((e) => e["@name"] === name);
  return field?.text?.["0"] || undefined;
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

  return result;
};

export const czSupremeAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_SUPREME,
  name: "Czech Supreme Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 500,

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
            adapterKey: ADAPTER_KEYS.CZ_SUPREME,
            cursor,
            httpStatus: listResponse.status,
          });
        }

        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Domino JSON API
        const json = (await listResponse.json()) as DominoViewResponse;
        const entries = json.viewentry ?? [];

        const decisions: IngestionResult[] = [];

        for (let i = 0; i < entries.length; i++) {
          // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- bounded by loop
          const entry = entries[i]!;
          const unid = entry["@unid"];
          const caseNumber = entryField(entry, "znacka");

          if (!unid || !caseNumber) {
            continue;
          }

          const detailUrl = `${BASE_URL}/WebSearch/${unid}?openDocument`;

          // Fetch the detail page for metadata
          try {
            const detailResponse = await fetch(detailUrl, {
              signal: signal
                ? AbortSignal.any([
                    signal,
                    AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
                  ])
                : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
            });

            if (detailResponse.ok) {
              const html = await detailResponse.text();
              const meta = parseDetailPage(html);

              const raw = `${caseNumber}|${meta.ecli ?? ""}|${meta.decisionDate ?? ""}`;

              decisions.push({
                caseNumber,
                ecli: meta.ecli,
                court: "Nejvyšší soud",
                country: "CZE",
                language: "cs",
                decisionDate: meta.decisionDate
                  ? parseCeDate(meta.decisionDate)
                  : undefined,
                decisionType: meta.decisionType?.toLowerCase(),
                sourceUrl: detailUrl,
                documentUrl: detailUrl,
                metadata: {
                  legalSentence: meta.legalSentence,
                  keywords: meta.keywords
                    ?.split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  statutes: meta.statutes
                    ?.split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  category: meta.category?.trim(),
                },
                rawHash: hashContent(raw),
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
            await Bun.sleep(200);
          }
        }

        const totalEntries = json["@toplevelentries"]
          ? Number.parseInt(json["@toplevelentries"], 10)
          : undefined;

        const nextCursor =
          totalEntries !== undefined
            ? start + entries.length <= totalEntries
              ? String(start + entries.length)
              : null
            : entries.length >= PAGE_SIZE
              ? String(start + entries.length)
              : null;

        return { decisions, nextCursor };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_SUPREME, cursor),
    });
  },
};
