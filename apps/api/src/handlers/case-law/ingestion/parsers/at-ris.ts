/** Parse the publisher-structured XML served by Austria's RIS. */
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

export type ParseRisDecisionOutput = {
  documentAst: DocumentAst;
  fulltext: string;
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

export const parseRisDecisionXml = (
  input: ParseRisDecisionInput,
): ParseRisDecisionOutput => {
  const $ = cheerio.load(input.xml, { xml: true });
  const content = $("nutzdaten").first();
  if (content.length === 0) {
    throw new ParseXmlError({
      message: "RIS XML has no nutzdaten element",
      cause: undefined,
    });
  }

  const validationContent = content.clone();
  validationContent.find("kzinhalt, fzinhalt").remove();
  const validationText = normalizedText(validationContent.text());
  if (validationText === "") {
    throw new ParseXmlError({
      message: "RIS XML nutzdaten element has no decision text",
      cause: undefined,
    });
  }

  const blocks: Block[] = [];
  let blockIndex = 0;

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
      appendParagraph(text, paragraphRole($(node).attr("ct")));
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
    throw new ParseXmlError({
      message: "RIS XML decision text produced no document blocks",
      cause: undefined,
    });
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

  return {
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
    validationIssues: validation.issues.map((issue) => issue.code),
  };
};
