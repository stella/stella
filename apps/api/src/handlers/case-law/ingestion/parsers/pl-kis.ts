// parser-output-unchanged: [pl-kis] imports the shared PDF reader from its new owner, pdf-bands.ts, under its new names; the default reading is the same code.
/**
 * Polish tax interpretations and rulings (EUREKA) document reader.
 *
 * The service states each document as HTML exported from a word processor,
 * and a PDF rendition of the same text for the documents whose HTML field is
 * empty. Both are read into the markup the Polish decision parser reads, so
 * there is one Polish parser and this is not a second one.
 *
 * Every kind of document the service publishes (interpretations, opinions,
 * rulings on rates, decisions, and the information about them) is one
 * authority's letter, set out by the authority's template: a title, the
 * ruling in the authority's own voice, then sections under headings. The
 * export marks a heading as the template sets it, in a heading style of its
 * own or wholly in bold; this reader states those lines as headings, and the
 * shared Polish grammar reads the parts from there. No kind is read by a
 * rule of its own, so a kind the service adds is read the same way, and a
 * document whose parts the reading cannot tell apart says so in its result.
 */

import { Result } from "better-result";

import { parseDecimalToken } from "@stll/agent-input/numeric-token";
import { load } from "@stll/html";
import type * as cheerio from "@stll/html";
import { type AnyNode, type Element, isTag, isText } from "@stll/html/nodes";
// parser-output-unchanged: imports the document AST from its package owner
import type { DocumentAst, ParagraphRole } from "@stll/legal-ast/document-ast";
import { statesPlAuthorityRuling } from "@stll/legal-ast/polish-document-roles";
import {
  PRINTED_LABEL_KIND,
  readPrintedLabel,
} from "@stll/legal-ast/printed-paragraph-labels";

import {
  assemblePdfParagraphs,
  extractPdfLines,
  pdfParagraphsToHtml,
} from "@/api/handlers/case-law/ingestion/parsers/pdf-bands";
import {
  parsePlDecisionContent,
  PL_DECISION_LAYOUT,
  PL_DECISION_MARKUP,
} from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import { visibleHtmlText } from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { inlineStyleValue } from "@/api/lib/legal-search/document-builders/inline-style";
import { continuesAcrossPageBreak } from "@/api/lib/legal-search/parsers/page-furniture";

/** Publisher recorded on the AST, so a stored document names where it came from. */
const PL_KIS_SOURCE_SYSTEM = "eureka.mf.gov.pl";

export type ParsePlKisDocumentInput = {
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string;
  documentUrl: string;
  documentId: string;
  keywords: string[];
  statutes: string[];
};

/**
 * Whether the reading told the document's parts apart. `undivided`: every
 * paragraph carries one role (`role`), so the document reads as one part,
 * which is how a layout the reading does not know shows; the text is all
 * there, its structure is not.
 */
type PlKisDocumentStructure =
  { type: "divided" } | { type: "undivided"; role: ParagraphRole | undefined };

export type ParsePlKisDocumentOutput = {
  documentAst: DocumentAst;
  fulltext: string;
  structure: PlKisDocumentStructure;
};

/**
 * The template's own paragraph styles for its title and headings, as the
 * export names them: `Tytuł interpretacji`, `Tytuł pisma`, and the first
 * and second heading levels.
 */
const TEMPLATE_HEADING_STYLES: ReadonlyMap<string, "h2" | "h3"> = new Map([
  ["Tytuinterpretacji", "h2"],
  ["Tytupisma", "h2"],
  ["TytupismaKAS", "h2"],
  ["1rdtytu", "h2"],
  ["2rdtytu", "h3"],
]);

/** A run of text as a reader sees it: no-break spaces and wraps are spaces. */
const visibleText = (text: string): string =>
  text.replaceAll(/[\s ]+/gu, " ").trim();

const BOLD_TAGS: ReadonlySet<string> = new Set(["b", "strong"]);
const BOLD_WEIGHT_THRESHOLD = 600;

/** An element's own weight, where its style states one: bold or not. */
const declaredBold = (element: Element): boolean | undefined =>
  inlineStyleValue(element, (property, value) => {
    if (property !== "font-weight") {
      return undefined;
    }
    if (value === "bold" || value === "bolder") {
      return { value: true };
    }
    if (value === "normal" || value === "lighter") {
      return { value: false };
    }
    const weight = parseDecimalToken(value.trim(), { sign: "unsigned" });
    return Result.isOk(weight)
      ? { value: weight.value >= BOLD_WEIGHT_THRESHOLD }
      : undefined;
  })?.value;

/** Whether a text node prints in bold: the nearest weight stated over it. */
const printsBold = (node: AnyNode, paragraph: Element): boolean => {
  for (
    let element = node.parent;
    element !== null && isTag(element);
    element = element.parent
  ) {
    const declared = declaredBold(element);
    if (declared !== undefined) {
      return declared;
    }
    if (BOLD_TAGS.has(element.name)) {
      return true;
    }
    if (element === paragraph) {
      return false;
    }
  }
  return false;
};

/** Every text node under an element, in document order. */
const textNodesOf = (element: Element): AnyNode[] => {
  const nodes: AnyNode[] = [];
  const pending: AnyNode[] = [...element.children].toReversed();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isText(node)) {
      nodes.push(node);
    } else if (isTag(node)) {
      pending.push(...[...node.children].toReversed());
    }
  }
  return nodes;
};

/** Whether every letter of a paragraph prints in bold. */
const setWhollyInBold = (paragraph: Element): boolean => {
  const printed = textNodesOf(paragraph).filter(
    (node) => isText(node) && visibleText(node.data) !== "",
  );
  return (
    printed.length > 0 && printed.every((node) => printsBold(node, paragraph))
  );
};

/**
 * A line that opens on a lowercase word goes on with the line above. A
 * lowercase point label (`i.`, `a)`) opens a point of its own.
 */
const OPENS_LOWERCASE_RE = /^\p{Ll}+(?![\p{L}.)])/u;

/**
 * A part of an outline lettered or numbered in Roman of either case (`A.`,
 * `b)`, `iii.`), which the printed-label grammar reads only as a ruling's
 * `IV.` or a list's `a)`.
 */
const LETTERED_OUTLINE_LABEL_RE = /^(?:[IVXLC]{1,6}|[ivxlc]{1,6}|\p{L})[.)] /u;

/** Whether a line opens on an outline label: `1.`, `2.1.`, `IV.`, `A.`. */
const opensOnOutlineLabel = (text: string): boolean => {
  const label = readPrintedLabel(text);
  return (
    (label !== null && label.kind !== PRINTED_LABEL_KIND.BULLET) ||
    LETTERED_OUTLINE_LABEL_RE.test(text)
  );
};
/** How a sentence or a clause ends, which no heading does. */
const CLAUSE_END_RE = /[.,;:?!…]$/u;
/** A date's year abbreviation (`19 czerwca 2026 r.`), which ends no sentence. */
const YEAR_ABBREVIATION_END_RE = /\d{4} r\.$/u;

/**
 * Whether a line set apart reads as a heading: it ends as no sentence does,
 * or opens on an outline label (`1. Opis zagadnienia … podatkowego.`). A
 * sentence set in bold for emphasis (`W związku z powyższym zadano
 * następujące pytanie:`) is the text, not a heading over it.
 */
const readsAsHeading = (text: string): boolean =>
  opensOnOutlineLabel(text) ||
  !CLAUSE_END_RE.test(text) ||
  YEAR_ABBREVIATION_END_RE.test(text);

/**
 * State the template's headings as heading elements, in place: a paragraph
 * in a heading style of the template, or set wholly in bold, that reads as
 * a heading, unless it is a line of the ruling (it states the authority's
 * ruling) or a line the next one goes on from (`Szanowni Państwo,` then
 * `stwierdzam, że …`; the authority's name set apart above `po
 * rozpatrzeniu …`). The text and its marks stay as printed.
 */
const stateTemplateHeadings = ($: cheerio.CheerioAPI): void => {
  const paragraphs = $("p")
    .toArray()
    .flatMap((paragraph) => {
      const text = visibleText(visibleHtmlText($(paragraph)));
      return text === "" ? [] : [{ paragraph, text }];
    });
  for (const [index, { paragraph, text }] of paragraphs.entries()) {
    const styled = TEMPLATE_HEADING_STYLES.get(
      paragraph.attribs["class"] ?? "",
    );
    const tag = styled ?? (setWhollyInBold(paragraph) ? "h2" : undefined);
    if (
      tag === undefined ||
      !readsAsHeading(text) ||
      statesPlAuthorityRuling(text)
    ) {
      continue;
    }
    const next = paragraphs[index + 1]?.text ?? "";
    if (OPENS_LOWERCASE_RE.test(next)) {
      continue;
    }
    // A heading is one line: a wrap inside it is a space, as in a paragraph.
    $(paragraph).find("br").replaceWith(" ");
    paragraph.name = tag;
  }
};

/**
 * A link to a place in the same document: the export marks one with an
 * `anchor` attribute or a `#` target.
 */
const IN_DOCUMENT_LINK = 'a[anchor], a[href^="#"]';

/**
 * Drop the lines that only link back within the document (`powrót do spisu`
 * after each section of a brochure): web navigation, not the document's
 * text. A link inside a sentence, such as a footnote mark, stays.
 */
const dropNavigationLines = ($: cheerio.CheerioAPI): void => {
  for (const link of $(IN_DOCUMENT_LINK).toArray()) {
    const line = $(link).closest("p");
    const text = visibleText(visibleHtmlText($(link)));
    if (
      line.length > 0 &&
      text !== "" &&
      visibleText(visibleHtmlText(line)) === text
    ) {
      line.remove();
    }
  }
};

/** The container the export sets each footnote in (`<div id="ftn6">`). */
const FOOTNOTE_CONTAINER = 'div[id^="ftn"]';

/**
 * Join a footnote's lines that one sentence runs across: the export can set
 * a note's wrapped line as a paragraph of its own (`… z dnia 7 grudnia 2025
 * r. zmieniające` / `rozporządzenie w sprawie …`). A note's line that ends
 * its sentence, or one the next does not go on from, stays a paragraph.
 */
const joinWrappedFootnoteLines = ($: cheerio.CheerioAPI): void => {
  for (const container of $(FOOTNOTE_CONTAINER).toArray()) {
    const lines = $(container).children("p").toArray();
    let previous = lines.at(0);
    for (const line of lines.slice(1)) {
      if (
        previous !== undefined &&
        continuesAcrossPageBreak(
          visibleText(visibleHtmlText($(previous))),
          visibleText(visibleHtmlText($(line))),
        )
      ) {
        $(previous).append(" ", $(line).contents());
        $(line).remove();
        continue;
      }
      previous = line;
    }
  }
};

const loadLetter = (html: string): cheerio.CheerioAPI => {
  const $ = load(html);
  dropNavigationLines($);
  joinWrappedFootnoteLines($);
  stateTemplateHeadings($);
  return $;
};

/** Whether the parse told any two of the document's paragraphs apart. */
const structureOf = (documentAst: DocumentAst): PlKisDocumentStructure => {
  const roles = new Set(
    documentAst.blocks.flatMap((block) =>
      block.type === "paragraph" ? [block.role] : [],
    ),
  );
  const [only] = roles;
  return roles.size > 1
    ? { type: "divided" }
    : { type: "undivided", role: only };
};

const parseContent = (
  input: ParsePlKisDocumentInput,
  content: string,
): ParsePlKisDocumentOutput => {
  const parsed = parsePlDecisionContent({
    caseNumber: input.caseNumber,
    // Poland issues no ECLI, and a tax authority's document carries none.
    ecli: undefined,
    court: input.court,
    decisionDate: input.decisionDate,
    decisionType: input.decisionType,
    sourceUrl: input.sourceUrl,
    documentUrl: input.documentUrl,
    content,
    loadHtml: loadLetter,
    keywords: input.keywords,
    statutes: input.statutes,
    documentId: input.documentId,
    sourceSystem: PL_KIS_SOURCE_SYSTEM,
    markup: PL_DECISION_MARKUP.PRINTED_LINES,
    layout: PL_DECISION_LAYOUT.SECTIONED_LETTER,
  });
  return { ...parsed, structure: structureOf(parsed.documentAst) };
};

/** The document's own HTML field. */
export const parsePlKisDocumentHtml = (
  input: ParsePlKisDocumentInput & { html: string },
): ParsePlKisDocumentOutput => parseContent(input, input.html);

/** The PDF rendition, for a document whose HTML field is empty. */
export const parsePlKisDocumentPdf = async (
  input: ParsePlKisDocumentInput & { pdfBytes: Uint8Array },
): Promise<ParsePlKisDocumentOutput> =>
  parseContent(
    input,
    pdfParagraphsToHtml(
      assemblePdfParagraphs(await extractPdfLines(input.pdfBytes)),
    ),
  );
