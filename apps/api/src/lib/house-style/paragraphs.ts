/**
 * What a paragraph of the document being converted looks like, before it is
 * given a house style.
 *
 * A paragraph is more than its text: the style it already carries, the
 * outline and list level that style resolves to, whether it is bold, in
 * capitals or centred, and what sits either side of it. A rule can only read
 * the outline level, which is exactly where plain documents mislead it — a
 * bold line in a document whose every paragraph is Normal is not a heading
 * because it is bold. The decision model is given all of it.
 *
 * The traversal is shared with the rewrite: both reach the same paragraphs in
 * the same order through `paragraphsWithin`, so a decision cannot land on a
 * different paragraph than the one it was taken for, and a paragraph cannot
 * be decided and then left out of the converted document.
 */

import { panic } from "better-result";
import * as slimdom from "slimdom";

import { paragraphRuns, paragraphText, W_NS } from "@/api/lib/docx/ooxml";
import {
  attr,
  childElement,
  isElement,
  numberingDeclaration,
  resolveNumbering,
} from "@/api/lib/house-style/catalogue";
import type {
  NumberingDeclaration,
  StyleDefinitions,
  StyleNumbering,
} from "@/api/lib/house-style/catalogue";

const PARAGRAPH_TEXT_MAX_CHARS = 400;
const NEIGHBOUR_TEXT_MAX_CHARS = 160;

/** A paragraph as the body holds it, with the traversal's own facts. */
export type BodyParagraph = {
  element: slimdom.Element;
  text: string;
  /** A cell paragraph is converted but never dropped: a cell needs one. */
  inTable: boolean;
};

type ParagraphSite = { element: slimdom.Element; inTable: boolean };

/**
 * Every paragraph under a node, in reading order, whatever wraps it: a table
 * cell, a content control, a custom-XML block. The walk stops at a paragraph
 * rather than descending into it, so a text box hanging off one of its runs
 * is outside what the conversion carries.
 */
const paragraphSites = (root: slimdom.Element): ParagraphSite[] => {
  const found: ParagraphSite[] = [];
  const walk = (node: slimdom.Node, inTable: boolean): void => {
    for (const child of node.childNodes) {
      if (!isElement(child) || child.namespaceURI !== W_NS) {
        continue;
      }
      if (child.localName === "p") {
        found.push({ element: child, inTable });
        continue;
      }
      if (child.localName === "sectPr") {
        continue;
      }
      walk(child, inTable || child.localName === "tbl");
    }
  };
  walk(root, false);
  return found;
};

/** The body's paragraphs in reading order, cell paragraphs included. */
export const bodyParagraphs = (body: slimdom.Element): BodyParagraph[] =>
  paragraphSites(body).map(({ element, inTable }) => ({
    element,
    text: paragraphText(element).trim(),
    inTable,
  }));

/**
 * The paragraphs under one node, found by the traversal `bodyParagraphs`
 * uses. The rewrite walks the source subtree and the copy it imported with
 * this, which is what makes the paragraphs it writes the paragraphs that were
 * decided rather than a second reading of the body that can drift from the
 * first.
 */
export const paragraphsWithin = (root: slimdom.Element): slimdom.Element[] =>
  paragraphSites(root).map(({ element }) => element);

/** The body's paragraphs read straight off a serialized `document.xml`. */
export const readBodyParagraphs = (documentXml: string): BodyParagraph[] => {
  const body = slimdom
    .parseXmlDocument(documentXml)
    .getElementsByTagNameNS(W_NS, "body")
    .at(0);
  return body === undefined ? [] : bodyParagraphs(body);
};

/**
 * A manually typed list marker: "1.", "2.1", "(a)", "(iv)", "A.". The
 * terminator is required, so a sentence opening with a year or an amount is
 * not mistaken for a numbered clause.
 */
const MANUAL_MARKER =
  /^(?:\d+(?:\.\d+)+\.?|\d+[.)]|\(\d+\)|\([A-Za-z]\)|\([ivxlcdm]{1,6}\)|\([IVXLCDM]{1,6}\)|[A-Za-z][.)])\s+/u;

export type ManualMarker = { marker: string; text: string };

export const stripManualMarker = (text: string): ManualMarker => {
  const matched = MANUAL_MARKER.exec(text);
  return matched === null
    ? { marker: "", text }
    : { marker: matched[0], text: text.slice(matched[0].length) };
};

type ParagraphNeighbour = { text: string; style: string };

export type ParagraphFeatures = {
  /** Position among the non-empty paragraphs, which is what is decided. */
  index: number;
  text: string;
  originalStyleId: string;
  originalStyleName: string;
  outlineLevel: number | null;
  numberingLevel: number | null;
  /** `w:numFmt` of the level the paragraph sits on, when it is numbered. */
  numberFormat: string | null;
  /** How that level prints its first number: "1.1", "(a)". */
  numberExample: string | null;
  /**
   * A number the drafter typed into the text ("2.1", "(a)"). The strongest
   * evidence of the level a paragraph sits on in a document whose styles say
   * nothing, so it is put to the decision model rather than only removed.
   */
  typedMarker: string | null;
  bold: boolean;
  allCaps: boolean;
  centred: boolean;
  inTable: boolean;
  previous: ParagraphNeighbour | null;
  next: ParagraphNeighbour | null;
};

const truncate = (text: string, max: number): string => {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
};

/**
 * Runs that carry text; a bookmark or a field marker says nothing about
 * weight. The runs come from the traversal the rewrite writes with, so the
 * emphasis the decision model is shown is the emphasis the paragraph has.
 */
const textRuns = (paragraph: slimdom.Element): slimdom.Element[] =>
  paragraphRuns(paragraph).filter((run) => childElement(run, "t") !== null);

const runToggle = (
  paragraph: slimdom.Element,
  localName: string,
): boolean | null => {
  const runs = textRuns(paragraph);
  if (runs.length === 0) {
    return null;
  }
  const on = runs.filter((run) => {
    const rPr = childElement(run, "rPr");
    return rPr !== null && childElement(rPr, localName) !== null;
  });
  // No run sets it: the style decides, which is what null asks the caller to
  // do. Some runs but not all: partly bold is not bold, because a body line
  // with one emphasised term is not a heading.
  return on.length === 0 ? null : on.length === runs.length;
};

type ParagraphNumberingOptions = {
  /** What the paragraph's own `w:pPr` says; it overrides its style. */
  declared: NumberingDeclaration;
  definitions: StyleDefinitions;
  styleId: string;
  /** The numbering the paragraph's style resolved to. */
  inherited: StyleNumbering | null;
};

/**
 * A paragraph's numbering. `w:numId` 0 switches numbering off for this
 * paragraph even where its style numbers it, so it answers `null` rather than
 * falling through to the style the way a paragraph that declares nothing does.
 */
const paragraphNumbering = ({
  declared,
  definitions,
  styleId,
  inherited,
}: ParagraphNumberingOptions): StyleNumbering | null => {
  switch (declared.type) {
    case "absent":
      return inherited;
    case "disabled":
      return null;
    case "reference":
      return resolveNumbering({
        numbering: definitions.numbering,
        declaration: declared,
        styleId,
      });
    default:
      declared satisfies never;
      return panic("Unhandled numbering declaration");
  }
};

export type ExtractParagraphFeaturesOptions = {
  paragraphs: readonly BodyParagraph[];
  definitions: StyleDefinitions;
};

/**
 * Features for the non-empty paragraphs, in body order. Empty paragraphs are
 * not decided: they carry no evidence, and the house style's own spacing
 * replaces the blank line they stood for.
 */
export const extractParagraphFeatures = ({
  paragraphs,
  definitions,
}: ExtractParagraphFeaturesOptions): ParagraphFeatures[] => {
  const filled = paragraphs.filter(({ text }) => text.length > 0);
  return filled.map(({ element, text, inTable }, index) => {
    const pPr = childElement(element, "pPr");
    const styleId =
      (pPr === null
        ? null
        : (() => {
            const pStyle = childElement(pPr, "pStyle");
            return pStyle === null ? null : attr(pStyle, "val");
          })()) ?? definitions.defaultStyleId;
    const definition = definitions.byId.get(styleId) ?? null;
    const numbering = paragraphNumbering({
      declared: numberingDeclaration(pPr),
      definitions,
      styleId,
      inherited: definition?.formatting.numbering ?? null,
    });
    const outlineFromParagraph =
      pPr === null ? null : childElement(pPr, "outlineLvl");
    const alignment = pPr === null ? null : childElement(pPr, "jc");
    const neighbour = (offset: number): ParagraphNeighbour | null => {
      const other = filled.at(index + offset);
      if (other === undefined || index + offset < 0) {
        return null;
      }
      const otherPPr = childElement(other.element, "pPr");
      const otherStyle =
        otherPPr === null ? null : childElement(otherPPr, "pStyle");
      return {
        text: truncate(other.text, NEIGHBOUR_TEXT_MAX_CHARS),
        style:
          (otherStyle === null ? null : attr(otherStyle, "val")) ??
          definitions.defaultStyleId,
      };
    };
    return {
      index,
      text: truncate(text, PARAGRAPH_TEXT_MAX_CHARS),
      originalStyleId: styleId,
      originalStyleName: definition?.name ?? styleId,
      outlineLevel:
        (outlineFromParagraph === null
          ? null
          : Number.parseInt(attr(outlineFromParagraph, "val") ?? "", 10)) ??
        definition?.formatting.outlineLevel ??
        null,
      typedMarker: (() => {
        const { marker } = stripManualMarker(text);
        return marker.length === 0 ? null : marker.trim();
      })(),
      numberingLevel: numbering?.level ?? null,
      numberFormat: numbering?.format ?? null,
      numberExample: numbering?.example ?? null,
      bold: runToggle(element, "b") ?? definition?.formatting.bold ?? false,
      allCaps:
        runToggle(element, "caps") ?? definition?.formatting.allCaps ?? false,
      centred:
        (alignment === null ? null : attr(alignment, "val")) === "center" ||
        definition?.formatting.alignment === "center",
      inTable,
      previous: neighbour(-1),
      next: neighbour(1),
    };
  });
};
