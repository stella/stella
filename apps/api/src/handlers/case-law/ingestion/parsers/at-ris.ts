/** Parse the publisher-structured XML served by Austria's RIS. */
import { Result } from "better-result";
import * as cheerio from "cheerio";

// parser-output-unchanged: imports the document AST from its package owner
// parser-output-unchanged: keeps the same tagged XML rejection in the parser-owned pure module.
import type {
  Block,
  DocumentAst,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";
import { plainTextOf } from "@stll/legal-ast/document-ast";
import { rewriteInlineWhitespace } from "@stll/legal-ast/inline-line";

import {
  readRisContent,
  risContentLoss,
  type RisItem,
} from "@/api/handlers/case-law/ingestion/parsers/at-ris-markup";
import { ParseXmlError } from "@/api/handlers/case-law/ingestion/parsers/parse-xml-error";
import { collapseLetterSpacing } from "@/api/lib/legal-search/parsers/letter-spacing";

export type ParseRisDecisionInput = {
  sourceDocumentId: string;
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string | undefined;
  xml: string;
};

/**
 * The text of each section the document prints, under the content type the
 * publisher labels it with.
 *
 * Sections of one content type are joined in printed order: a court writes
 * its reasons as many paragraphs, and a reader of `text` wants the passage,
 * not its first paragraph.
 */
export type RisDocumentSections = Readonly<Record<string, string>>;

export type ParseRisDecisionOutput = {
  documentAst: DocumentAst;
  /** Elements outside the RIS vocabulary; their text is kept. */
  unknownElements: readonly string[];
  fulltext: string;
  sections: RisDocumentSections;
};

const paragraphRole = (
  contentType: string | undefined,
): ParagraphRole | undefined => {
  switch (contentType) {
    case "entscheidungsdatum":
    case "gericht":
    case "organ":
    case "kopf": {
      return "intro";
    }
    case "gz": {
      return "case-number";
    }
    case "schlusssatz": {
      return "closing";
    }
    case "spruch": {
      return "holding";
    }
    case "begruendung":
    case "rechtlichebeurteilung":
    case "text": {
      return "argumentation";
    }
    case "leitsatz": {
      return "syllabus";
    }
    case "betreff": {
      return "summary";
    }
    case "rechtssatz":
    case "strs": {
      return "headnotes";
    }
    case "ecli":
    case "entscheidungstexte":
    case "hinweisstrs":
    case "kurzbezeichnung":
    case "norm":
    case "rechtssatznummer": {
      return "apparatus";
    }
    case "unterschrift": {
      return "signature";
    }
    case undefined: {
      return undefined;
    }
    default: {
      return undefined;
    }
  }
};

/**
 * Every content type this document labels a section with.
 *
 * The inventory reads the stored XML through this, so a section type the
 * publisher starts printing arrives as a named field rather than as a
 * paragraph nothing accounted for. Page furniture is left out for the reason
 * the parser drops it: the header and footer repeat the host and the page
 * number, and neither is a section of the decision. A payload with no
 * decision element in it labels nothing, which is what the caller is told:
 * the parser below is where an unreadable document is an error.
 */
export const listRisDocumentContentTypes = (xml: string): readonly string[] => {
  const $ = cheerio.load(xml, { xml: true });
  const content = $("nutzdaten").first();
  const contentTypes = new Set<string>();
  content.find("absatz[ct]").each((_, element) => {
    if (content.find("kzinhalt, fzinhalt").find(element).length > 0) {
      return;
    }
    const contentType = element.attribs["ct"];
    if (contentType !== undefined && contentType !== "") {
      contentTypes.add(contentType);
    }
  });
  return [...contentTypes];
};

type RisParagraphItem = Extract<RisItem, { type: "paragraph" }>;

/**
 * A document whose `abstand` count is this share of its `absatz` count
 * separates paragraphs with `abstand`. Documents set from a typed
 * transcript print every wrapped line as an `absatz` and only a real
 * paragraph break as an `abstand`; courts that print one `absatz` per
 * paragraph use `abstand` seldom.
 */
const MIN_ABSTAND_SHARE = 0.2;

/** A sentence ends here: the author ended the line, not a margin. */
const SENTENCE_END_RE = /[.!?:;]["'’“”»«)\]]*$/u;

/** A list marker or numbered point opens a unit of its own. */
const STRUCTURAL_START_RE =
  /^(?:\(?\d{1,3}[.)]|\(?[IVXLC]{1,6}[.)]|\(?\p{L}\)|[-–•*])(?:\s|$)/u;

const continuesLine = (above: string, below: string): boolean =>
  !SENTENCE_END_RE.test(above) && !STRUCTURAL_START_RE.test(below);

const wrappableText = (item: RisItem | undefined): string | undefined =>
  item?.type === "paragraph" &&
  item.element === "absatz" &&
  item.layout !== "pre"
    ? plainTextOf(item.inlines)
    : undefined;

/**
 * Join the printed lines of an abstand-delimited transcript into
 * paragraphs: consecutive `absatz` lines of one content type belong to one
 * paragraph when the first stops mid-sentence. Elsewhere every `absatz` is
 * a paragraph, as the publisher sets it.
 */
const joinWrappedLines = (items: readonly RisItem[]): RisItem[] => {
  const breaks = items.filter((item) => item.type === "break").length;
  const lines = items.filter(
    (item) => wrappableText(item) !== undefined,
  ).length;
  if (lines === 0 || breaks < lines * MIN_ABSTAND_SHARE) {
    return [...items];
  }
  const joined: RisItem[] = [];
  let current: RisParagraphItem | undefined;
  for (const item of items) {
    const above = wrappableText(current);
    const below = wrappableText(item);
    if (
      current !== undefined &&
      item.type === "paragraph" &&
      above !== undefined &&
      below !== undefined &&
      item.contentType === current.contentType &&
      continuesLine(above, below)
    ) {
      current.inlines.push({ type: "text", text: " " }, ...item.inlines);
      continue;
    }
    if (current !== undefined) {
      joined.push(current);
      current = undefined;
    }
    if (item.type === "paragraph" && below !== undefined) {
      current = { ...item, inlines: [...item.inlines] };
      continue;
    }
    joined.push(item);
  }
  if (current !== undefined) {
    joined.push(current);
  }
  return joined;
};

type RisParseFailure = "no-text" | "no-blocks" | "content-lost";

const FAILURE_MESSAGE = {
  "no-text": "RIS XML nutzdaten element has no decision text",
  "no-blocks": "RIS XML decision text produced no document blocks",
  "content-lost": "RIS XML decision text did not survive into the document",
} as const satisfies Record<RisParseFailure, string>;

const parseFailure = (failure: RisParseFailure, cause?: unknown) =>
  Result.err(new ParseXmlError({ message: FAILURE_MESSAGE[failure], cause }));

export const parseRisDecisionXml = (
  input: ParseRisDecisionInput,
): Result<ParseRisDecisionOutput, ParseXmlError> => {
  const $ = cheerio.load(input.xml, { xml: true });
  const content = $("nutzdaten").first().get(0);
  if (content === undefined) {
    return Result.err(
      new ParseXmlError({
        message: "RIS XML has no nutzdaten element",
        cause: undefined,
      }),
    );
  }

  const { items, unknownElements } = readRisContent(content);
  if (items.length === 0) {
    return parseFailure("no-text");
  }
  const lost = risContentLoss(content, items);
  if (lost !== 0) {
    return parseFailure("content-lost", { lost });
  }

  const blocks: Block[] = [];
  const sections = new Map<string, string[]>();
  let blockIndex = 0;
  for (const item of joinWrappedLines(items)) {
    if (item.type === "break") {
      continue;
    }
    const inlines = rewriteInlineWhitespace(
      item.inlines,
      collapseLetterSpacing,
    );
    const text = plainTextOf(inlines);
    blockIndex += 1;
    if (item.type === "heading") {
      blocks.push({
        id: `b${blockIndex}`,
        anchorId: `h-${blockIndex}`,
        type: "heading",
        level: 1,
        role: "section-heading",
        inlines,
        plainText: text,
      });
      continue;
    }
    if (item.contentType !== undefined) {
      const printed = sections.get(item.contentType);
      if (printed === undefined) {
        sections.set(item.contentType, [text]);
      } else {
        printed.push(text);
      }
    }
    const role = paragraphRole(item.contentType);
    blocks.push({
      id: `b${blockIndex}`,
      anchorId: `p-${blockIndex}`,
      type: "paragraph",
      ...(role ? { role } : {}),
      inlines,
      plainText: text,
    });
  }
  if (blocks.length === 0) {
    return parseFailure("no-blocks");
  }

  return Result.ok({
    documentAst: {
      version: 1,
      source: {
        system: "ris.bka.gv.at",
        documentId: input.sourceDocumentId,
        webUrl: input.sourceUrl ?? "",
        printUrl: "",
      },
      metadata: {
        caseNumber: input.caseNumber,
        ecli: input.ecli ?? null,
        court: input.court,
        decisionDate: input.decisionDate ?? null,
        decisionType: input.decisionType ?? null,
        keywords: [],
        statutes: [],
      },
      blocks,
    },
    fulltext: blocks.map((block) => block.plainText).join("\n\n"),
    sections: Object.fromEntries(
      [...sections].map(([contentType, printed]) => [
        contentType,
        printed.join("\n\n"),
      ]),
    ),
    unknownElements,
  });
};
