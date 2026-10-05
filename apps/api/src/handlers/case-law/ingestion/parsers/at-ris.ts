/** Parse the publisher-structured XML served by Austria's RIS. */
import { Result } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

import type {
  Block,
  DocumentAst,
  ParagraphRole,
} from "@/api/handlers/case-law/document-ast";
import { ParseXmlError } from "@/api/lib/errors/tagged-errors";
import {
  buildValidationHtml,
  validateAndLog,
} from "@/api/lib/legal-search/parsers/validate-ast";

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
  fulltext: string;
  sections: RisDocumentSections;
  validationIssues: string[];
};

const normalizedText = (text: string): string =>
  text
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const elementText = ($: cheerio.CheerioAPI, element: Element): string =>
  normalizedText($(element).text());

const isPageFurniture = ($: cheerio.CheerioAPI, node: AnyNode): boolean =>
  $(node).closest("kzinhalt, fzinhalt").length > 0;

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

export const parseRisDecisionXml = (
  input: ParseRisDecisionInput,
): Result<ParseRisDecisionOutput, ParseXmlError> => {
  const $ = cheerio.load(input.xml, { xml: true });
  const content = $("nutzdaten").first();
  if (content.length === 0) {
    return Result.err(
      new ParseXmlError({
        message: "RIS XML has no nutzdaten element",
        cause: undefined,
      }),
    );
  }

  const validationContent = content.clone();
  validationContent.find("kzinhalt, fzinhalt").remove();
  const validationText = normalizedText(validationContent.text());
  if (validationText === "") {
    return Result.err(
      new ParseXmlError({
        message: "RIS XML nutzdaten element has no decision text",
        cause: undefined,
      }),
    );
  }

  const blocks: Block[] = [];
  const sections = new Map<string, string[]>();
  let blockIndex = 0;

  const appendSection = (contentType: string, text: string): void => {
    const printed = sections.get(contentType);
    if (printed === undefined) {
      sections.set(contentType, [text]);
      return;
    }
    printed.push(text);
  };

  const appendParagraph = (
    text: string,
    role: ParagraphRole | undefined,
  ): void => {
    if (text === "") {
      return;
    }
    blockIndex += 1;
    blocks.push({
      id: `b${blockIndex}`,
      anchorId: `p-${blockIndex}`,
      type: "paragraph",
      ...(role ? { role } : {}),
      inlines: [{ type: "text", text }],
      plainText: text,
    });
  };

  const appendNode = (node: AnyNode): void => {
    if (!isTag(node)) {
      if (isText(node)) {
        appendParagraph(normalizedText(node.data), undefined);
      }
      return;
    }
    if (isPageFurniture($, node)) {
      return;
    }
    const text = elementText($, node);
    if (text === "") {
      return;
    }
    if (node.tagName === "ueberschrift") {
      blockIndex += 1;
      blocks.push({
        id: `b${blockIndex}`,
        anchorId: `h-${blockIndex}`,
        type: "heading",
        level: 1,
        role: "section-heading",
        inlines: [{ type: "text", text }],
        plainText: text,
      });
      return;
    }

    if (node.tagName === "absatz") {
      const contentType = $(node).attr("ct");
      if (contentType !== undefined && contentType !== "") {
        appendSection(contentType, text);
      }
      appendParagraph(text, paragraphRole(contentType));
      return;
    }

    if ($(node).find("ueberschrift, absatz").length === 0) {
      appendParagraph(text, undefined);
      return;
    }
    $(node)
      .contents()
      .each((_, child) => {
        appendNode(child);
      });
  };

  content.contents().each((_, node) => {
    appendNode(node);
  });
  if (blocks.length === 0) {
    return Result.err(
      new ParseXmlError({
        message: "RIS XML decision text produced no document blocks",
        cause: undefined,
      }),
    );
  }

  const validation = validateAndLog(
    {
      parser: "at-ris",
      caseNumber: input.caseNumber,
      language: "de",
      url: input.sourceUrl,
    },
    buildValidationHtml([validationText]),
    blocks,
  );

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
    validationIssues: validation.issues.map((issue) => issue.code),
  });
};
