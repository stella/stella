/**
 * Which text column of an opinion row becomes its document.
 *
 * Columns are tried in a fixed precedence, structural XML first. A column is
 * dispatched on the structure it holds, not its name: `html_with_citations`
 * may hold Harvard XML or a preformatted body. An unusable candidate is
 * recorded and the next one tried; a parsed candidate must also pass the
 * shared content-retention check. A candidate needing assets, one of a
 * structure no parser reads yet, or a spent budget ends the selection: a
 * lower column would stand in for text it does not hold.
 */

import { panic } from "better-result";

import type { OpinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/snapshot-columns";
import type { OpinionType } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/vocabulary";
import { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";

import { parseHarvardXml, withoutXmlDeclaration } from "./harvard-xml";
import {
  type CourtListenerTextLimit,
  type FormatParse,
  type ParsedOpinionText,
  TEXT_CANDIDATE_UNUSABLE,
  type TextBudget,
  type TextCandidateUnusable,
} from "./outcome";
import { parsePlainText, parsePreformatted } from "./plain-text";

/** Text columns in precedence order. `xml_scan` is never text: see below. */
export const COURTLISTENER_TEXT_FORMATS = [
  "xml_harvard",
  "html_with_citations",
  "html_lawbox",
  "html_columbia",
  "html_anon_2020",
  "html",
  "plain_text",
] as const satisfies readonly (keyof OpinionRow)[];

type CourtListenerTextFormat = (typeof COURTLISTENER_TEXT_FORMATS)[number];

/** The structure a column holds, which decides its parser. */
export type TextStructure = "xml" | "pre" | "plain" | "html";

const OPINION_ROOT = /^<opinion[\s>/]/u;
const PREFORMATTED_ROOT = /^<pre[\s>]/iu;

export const textStructureOf = (
  format: CourtListenerTextFormat,
  text: string,
): TextStructure => {
  if (format === "plain_text") {
    return "plain";
  }
  const head = withoutXmlDeclaration(text).trimStart();
  if (format === "xml_harvard" || OPINION_ROOT.test(head)) {
    return "xml";
  }
  return PREFORMATTED_ROOT.test(head) ? "pre" : "html";
};

type ParserInput = Parameters<typeof parseHarvardXml>[0];

const PARSERS = {
  xml: parseHarvardXml,
  pre: parsePreformatted,
  plain: parsePlainText,
  html: (): FormatParse => ({ status: "unsupported", structure: "html" }),
} as const satisfies Record<TextStructure, (input: ParserInput) => FormatParse>;

type CandidateAttempt = {
  readonly format: CourtListenerTextFormat;
  readonly structure: TextStructure;
  readonly reason: TextCandidateUnusable;
};

export type OpinionTextSelection =
  | {
      readonly status: "parsed";
      readonly format: CourtListenerTextFormat;
      readonly structure: TextStructure;
      readonly text: ParsedOpinionText;
      readonly attempts: readonly CandidateAttempt[];
    }
  | {
      readonly status: "requires-assets";
      /** `xml_scan` when a scan layout was the only representation left. */
      readonly format: CourtListenerTextFormat | "xml_scan";
      readonly images: number;
      readonly attempts: readonly CandidateAttempt[];
    }
  | {
      readonly status: "unsupported";
      readonly format: CourtListenerTextFormat;
      readonly structure: string;
      readonly attempts: readonly CandidateAttempt[];
    }
  | {
      readonly status: "over-limit";
      readonly limit: CourtListenerTextLimit;
      readonly attempts: readonly CandidateAttempt[];
    }
  | {
      readonly status: "no-usable-text";
      readonly attempts: readonly CandidateAttempt[];
    };

const RESIDUE = "MARKUP_RESIDUE";

/** Why the retention check refused a parse, or `null` when it passed. */
const retentionFailure = (
  row: OpinionRow,
  text: ParsedOpinionText,
): TextCandidateUnusable | null => {
  const result = validateAndLog(
    {
      parser: "courtlistener",
      caseNumber: `cl-opinion:${row.id}`,
      language: "en",
    },
    text.validationHtml,
    text.units.flatMap(({ blocks }) => [...blocks]),
  );
  if (result.ok) {
    return null;
  }
  return result.issues.some(({ code }) => code === RESIDUE)
    ? TEXT_CANDIDATE_UNUSABLE.MARKUP_RESIDUE
    : TEXT_CANDIDATE_UNUSABLE.CONTENT_LOSS;
};

/**
 * The first usable column of `row`, or why there is none. Scan-layout XML
 * holds positioned glyphs, not text: where it is all that is left, the
 * opinion needs its page images.
 */
export const selectOpinionText = ({
  budget,
  row,
  type,
}: {
  readonly row: OpinionRow;
  readonly type: OpinionType;
  readonly budget: TextBudget;
}): OpinionTextSelection => {
  const attempts: CandidateAttempt[] = [];
  for (const format of COURTLISTENER_TEXT_FORMATS) {
    const source = row[format];
    const structure = textStructureOf(format, source);
    if (source.trim() === "") {
      attempts.push({
        format,
        structure,
        reason: TEXT_CANDIDATE_UNUSABLE.BLANK,
      });
      continue;
    }
    const parsed = PARSERS[structure]({
      text: source,
      prefix: `o${row.id}`,
      rowType: type,
      budget,
    });
    switch (parsed.status) {
      case "parsed": {
        const refused = retentionFailure(row, parsed.text);
        if (refused === null) {
          budget.blocks += parsed.text.units.reduce(
            (sum, { blocks }) => sum + blocks.length,
            0,
          );
          return {
            status: "parsed",
            format,
            structure,
            text: parsed.text,
            attempts,
          };
        }
        attempts.push({ format, structure, reason: refused });
        break;
      }
      case "unusable":
        attempts.push({ format, structure, reason: parsed.reason });
        break;
      case "requires-assets":
        return {
          status: "requires-assets",
          format,
          images: parsed.images,
          attempts,
        };
      case "unsupported":
        return {
          status: "unsupported",
          format,
          structure: parsed.structure,
          attempts,
        };
      case "over-limit":
        return { status: "over-limit", limit: parsed.limit, attempts };
      default: {
        parsed satisfies never;
        return panic(`Unhandled text outcome: ${String(parsed)}`);
      }
    }
  }
  return row.xml_scan.trim() === ""
    ? { status: "no-usable-text", attempts }
    : { status: "requires-assets", format: "xml_scan", images: 0, attempts };
};
