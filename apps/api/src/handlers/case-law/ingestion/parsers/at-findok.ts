/** Parse Findok's decision XML envelope and embedded publisher XHTML. */
import { Result } from "better-result";
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
  /** The one-line subject the ministry prints over the decision. */
  betreff: string | undefined;
  ecli: string | undefined;
  fulltext: string;
  keywords: string[];
  /** The version bookkeeping and the section headings the envelope states. */
  envelope: FindokEnvelopeFields;
  statutes: string[];
  subjectCodes: string[];
  validationIssues: string[];
};

/**
 * The document envelope's own fields, beside the XHTML it wraps.
 *
 * Read as a record rather than as loose arguments: they are a dozen values of
 * one publisher structure, and the adapter stores them under keys of its own.
 */
type FindokEnvelopeFields = {
  readonly headings: string[];
  readonly lastChangedAt: string | undefined;
  readonly officiallyPublished: string | undefined;
  readonly originalCaseNumber: string | undefined;
  readonly publishedAt: string | undefined;
  readonly validUntil: string | undefined;
  readonly versionNumber: string | undefined;
  readonly globalId: string | undefined;
};

/**
 * One headnote document of the same archive.
 *
 * The ministry files the legal sentences of a decision as a second XML beside
 * its text, in the same envelope but with a body element of its own: the
 * sentence is `txtascii`, and a reader looking for the `txt` the decision
 * text uses finds nothing.
 */
export type ParseFindokHeadnotesOutput = {
  readonly envelope: FindokEnvelopeFields;
  readonly headnoteNumbers: string[];
  readonly legalSentence: string | undefined;
  readonly statutes: string[];
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

/**
 * Every element name the document envelope states, in either entry.
 *
 * A `…_sub` element is the schema's wrapper around a repeated value, so its
 * children are the fields and the wrapper is not one: what the inventory has
 * to account for is `ngesamt`, not the container it repeats inside.
 */
export const listFindokDocumentFields = (xml: string): readonly string[] => {
  const $ = cheerio.load(xml, { xml: true });
  const names = new Set<string>();
  for (const group of ["Grundk", "Segk"]) {
    $(group)
      .children()
      .each((_, element) => {
        if (!isTag(element)) {
          return;
        }
        if (element.tagName.endsWith("_sub")) {
          $(element)
            .children()
            .each((__, child) => {
              if (isTag(child)) {
                names.add(`${group}/${child.tagName}`);
              }
            });
          return;
        }
        names.add(`${group}/${element.tagName}`);
      });
  }
  return [...names];
};

const envelopeFields = ($: cheerio.CheerioAPI): FindokEnvelopeFields => ({
  headings: distinctTexts($, "Grundk uebersex_net"),
  lastChangedAt: optionalText($, "Grundk > lastchangedat"),
  officiallyPublished: optionalText($, "Grundk > av_veroeffentlicht"),
  originalCaseNumber: optionalText($, "Grundk > erstfass"),
  publishedAt: optionalText($, "Grundk > vadat"),
  validUntil: optionalText($, "Grundk > appdatbis"),
  versionNumber: optionalText($, "Grundk > fsgnr"),
  globalId: optionalText($, "Grundk > gid"),
});

/**
 * Read the headnote document the archive carries beside the decision text.
 *
 * A `legalSentence` of `undefined` is an entry this parser could not read,
 * not a decision the ministry wrote no sentence for: the entry exists because
 * headnotes were filed, so the caller states the difference on the row rather
 * than storing silence.
 */
export const parseFindokHeadnoteXml = (
  xml: string,
): ParseFindokHeadnotesOutput => {
  const $ = cheerio.load(xml, { xml: true });
  const sentences = $("Segk > txtascii")
    .toArray()
    .map((element) => normalizedText($(element).text()))
    .filter((text) => text !== "");
  return {
    envelope: envelopeFields($),
    headnoteNumbers: distinctTexts($, "Segk > rsnr"),
    legalSentence: sentences.length === 0 ? undefined : sentences.join("\n\n"),
    statutes: distinctTexts($, "Segk ngesamt"),
  };
};

export const parseFindokDecisionXml = (
  input: ParseFindokDecisionInput,
): Result<ParseFindokDecisionOutput, ParseXmlError> => {
  const envelope = cheerio.load(input.xml, { xml: true });
  const xhtmlSegments = envelope("Segk > txt")
    .toArray()
    .map((element) => envelope(element).text())
    .filter((xhtml) => normalizedText(xhtml) !== "");
  if (xhtmlSegments.length === 0) {
    return Result.err(
      new ParseXmlError({
        message: "Findok XML has no embedded decision XHTML",
        cause: undefined,
      }),
    );
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

  const appendNode = (node: AnyNode, document: cheerio.CheerioAPI): void => {
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
        appendNode(child, document);
      });
  };

  for (const xhtml of xhtmlSegments) {
    const document = cheerio.load(xhtml);
    const body = document("body").first();
    const validationText = normalizedText(body.text());
    if (body.length === 0 || validationText === "") {
      return Result.err(
        new ParseXmlError({
          message: "Findok embedded XHTML has no decision text",
          cause: undefined,
        }),
      );
    }
    validationParts.push(validationText);

    body.contents().each((_, node) => {
      appendNode(node, document);
    });
  }

  if (blocks.length === 0) {
    return Result.err(
      new ParseXmlError({
        message: "Findok decision produced no document blocks",
        cause: undefined,
      }),
    );
  }

  const ecli = optionalText(envelope, "Grundk > ecli");
  const keywords = distinctTexts(envelope, "Grundk matbez_erf");
  const statutes = distinctTexts(envelope, "Grundk ngesamt_erf");
  const subjectCodes = distinctTexts(envelope, "Grundk matnr_erf");
  const betreff = optionalText(envelope, "Grundk > betreff");
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
  return Result.ok({
    betreff,
    envelope: envelopeFields(envelope),
    subjectCodes,
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
  });
};
