/** Parse Findok's decision XML envelope and embedded publisher XHTML. */
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

import type { Block, DocumentAst } from "@/api/handlers/case-law/document-ast";
import { ParseXmlError } from "@/api/lib/errors/tagged-errors";
import {
  buildValidationHtml,
  validateAndLog,
} from "@/api/lib/legal-search/parsers/validate-ast";

export type ParseFindokDecisionInput = {
  caseNumber: string;
  court: string;
  decisionDate: string;
  decisionType: string;
  sourceDocumentId: string;
  sourceUrl: string;
  xml: string;
};

export type ParseFindokDecisionOutput = {
  documentAst: DocumentAst;
  ecli: string | undefined;
  fulltext: string;
  keywords: string[];
  statutes: string[];
  validationIssues: string[];
};

const normalizedText = (text: string): string =>
  text
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const optionalText = (
  $: cheerio.CheerioAPI,
  selector: string,
): string | undefined => {
  const text = normalizedText($(selector).first().text());
  return text === "" ? undefined : text;
};

const distinctTexts = ($: cheerio.CheerioAPI, selector: string): string[] => [
  ...new Set(
    $(selector)
      .toArray()
      .map((element) => normalizedText($(element).text()))
      .filter((text) => text !== ""),
  ),
];

const headingLevel = (element: Element): 1 | 2 | 3 => {
  const raw = Number(element.tagName.slice(1));
  if (raw <= 1) {
    return 1;
  }
  return raw === 2 ? 2 : 3;
};

export const parseFindokDecisionXml = (
  input: ParseFindokDecisionInput,
): ParseFindokDecisionOutput => {
  const envelope = cheerio.load(input.xml, { xml: true });
  const xhtmlSegments = envelope("Segk > txt")
    .toArray()
    .map((element) => envelope(element).text())
    .filter((xhtml) => normalizedText(xhtml) !== "");
  if (xhtmlSegments.length === 0) {
    throw new ParseXmlError({
      message: "Findok XML has no embedded decision XHTML",
      cause: undefined,
    });
  }

  const blocks: Block[] = [];
  const validationParts: string[] = [];
  let blockIndex = 0;
  const appendParagraph = (text: string): void => {
    if (text === "") {
      return;
    }
    blockIndex += 1;
    blocks.push({
      id: `b${blockIndex}`,
      anchorId: `p-${blockIndex}`,
      type: "paragraph",
      inlines: [{ type: "text", text }],
      plainText: text,
    });
  };

  for (const xhtml of xhtmlSegments) {
    const document = cheerio.load(xhtml);
    const body = document("body").first();
    const validationText = normalizedText(body.text());
    if (body.length === 0 || validationText === "") {
      throw new ParseXmlError({
        message: "Findok embedded XHTML has no decision text",
        cause: undefined,
      });
    }
    validationParts.push(validationText);

    const appendNode = (node: AnyNode): void => {
      if (!isTag(node)) {
        if (isText(node)) {
          appendParagraph(normalizedText(node.data));
        }
        return;
      }
      const text = normalizedText(document(node).text());
      if (text === "") {
        return;
      }
      if (/^h[1-6]$/u.test(node.tagName)) {
        blockIndex += 1;
        blocks.push({
          id: `b${blockIndex}`,
          anchorId: `h-${blockIndex}`,
          type: "heading",
          level: headingLevel(node),
          role: blockIndex === 1 ? "decision-title" : "section-heading",
          inlines: [{ type: "text", text }],
          plainText: text,
        });
        return;
      }
      if (node.tagName === "p" || node.tagName === "li") {
        appendParagraph(text);
        return;
      }
      if (document(node).find("h1, h2, h3, h4, h5, h6, p, li").length === 0) {
        appendParagraph(text);
        return;
      }
      document(node)
        .contents()
        .each((_, child) => {
          appendNode(child);
        });
    };

    body.contents().each((_, node) => {
      appendNode(node);
    });
  }

  if (blocks.length === 0) {
    throw new ParseXmlError({
      message: "Findok decision produced no document blocks",
      cause: undefined,
    });
  }

  const ecli = optionalText(envelope, "Grundk > ecli");
  const keywords = distinctTexts(envelope, "Grundk matbez_erf");
  const statutes = distinctTexts(envelope, "Grundk ngesamt_erf");
  const validation = validateAndLog(
    {
      parser: "at-findok",
      caseNumber: input.caseNumber,
      language: "de",
      url: input.sourceUrl,
    },
    buildValidationHtml(validationParts),
    blocks,
  );
  return {
    documentAst: {
      version: 1,
      source: {
        system: "findok.bmf.gv.at",
        documentId: input.sourceDocumentId,
        webUrl: input.sourceUrl,
        printUrl: input.sourceUrl,
      },
      metadata: {
        caseNumber: input.caseNumber,
        ecli: ecli ?? null,
        court: input.court,
        decisionDate: input.decisionDate,
        decisionType: input.decisionType,
        keywords,
        statutes,
      },
      blocks,
    },
    ecli,
    fulltext: blocks.map((block) => block.plainText).join("\n\n"),
    keywords,
    statutes,
    validationIssues: validation.issues.map((issue) => issue.code),
  };
};
