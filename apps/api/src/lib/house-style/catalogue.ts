/**
 * What a house style is made of: the paragraph styles its document actually
 * uses, each with the formatting a reader sees after `basedOn` inheritance
 * and with the number its level prints.
 *
 * A style set is a DOCX whose styles carry the firm's drafting hierarchy
 * (numbered headings, numbered body levels, definitions, parties, annexes).
 * Nothing here reads the file: the catalogue is built from the three parts
 * that describe it, so the same extraction runs over a fixture string in a
 * test and over an uploaded style set in a handler.
 *
 * The catalogue is also the contract a style guide is written against: its
 * `hash` covers the style ids and their resolved formatting, so a replaced
 * style-set file invalidates a guide that no longer describes it.
 */

import { panic } from "better-result";
import * as slimdom from "slimdom";

import { stableStringify } from "@stll/stable-stringify";

import { paragraphText, W_NS } from "@/api/lib/docx/ooxml";

/** A style's automatic numbering, as `numbering.xml` defines it. */
export type StyleNumbering = {
  numId: number;
  level: number;
  /** `w:numFmt`: decimal, lowerLetter, lowerRoman, bullet, none, … */
  format: string;
  /** `w:lvlText` with its placeholders filled from each level's start: "1.1", "(a)". */
  example: string;
};

/** Effective paragraph formatting, after `basedOn` and the document defaults. */
type StyleFormatting = {
  font: string | null;
  sizePt: number | null;
  bold: boolean;
  italic: boolean;
  allCaps: boolean;
  /** `w:jc`: left, center, right, both. */
  alignment: string | null;
  indentLeftTwips: number | null;
  indentFirstLineTwips: number | null;
  indentHangingTwips: number | null;
  spaceBeforeTwips: number | null;
  spaceAfterTwips: number | null;
  /** `w:outlineLvl`, zero-based; null for a style outside the outline. */
  outlineLevel: number | null;
  numbering: StyleNumbering | null;
};

export type CatalogueStyle = {
  id: string;
  name: string;
  basedOn: string | null;
  /** Non-empty paragraphs carrying this style; zero in a content-free set. */
  usageCount: number;
  formatting: StyleFormatting;
  /** Up to `MAX_EXAMPLES` paragraphs, truncated, as the style is used. */
  examples: string[];
};

export type StyleCatalogue = {
  /** Over the ids, names and formatting: a replaced file invalidates its guide. */
  hash: string;
  /** The style a paragraph carries when it names none: plain body text. */
  defaultStyleId: string;
  styles: CatalogueStyle[];
};

/** A substring rewrite over style ids and display names, e.g. a house prefix. */
export type RenameRule = { from: string; to: string };

const MAX_EXAMPLES = 3;
const EXAMPLE_MAX_CHARS = 240;
const HALF_POINTS_PER_POINT = 2;
/** The style Word falls back to when no `w:style` declares `w:default`. */
const DEFAULT_STYLE_ID = "Normal";

/** Elements whose `w:val` names a style, so a rename reaches every reference. */
const STYLE_REFERENCE_ELEMENTS = new Set([
  "pStyle",
  "basedOn",
  "next",
  "link",
  "styleLink",
  "numStyleLink",
  "tblStyle",
]);

export const applyRename = (
  value: string,
  rules: readonly RenameRule[],
): string => {
  let renamed = value;
  for (const { from, to } of rules) {
    renamed = renamed.replaceAll(from, () => to);
  }
  return renamed;
};

/**
 * Every style id, display name and style reference rewritten in place, so a
 * renamed `styles.xml` still matches the `numbering.xml` levels that link to
 * its styles and the paragraphs that carry them.
 */
const renameStylesInDocument = (
  doc: slimdom.Document,
  rules: readonly RenameRule[],
): void => {
  if (rules.length === 0) {
    return;
  }
  const walk = (node: slimdom.Node): void => {
    for (const child of node.childNodes) {
      if (!isElement(child)) {
        continue;
      }
      if (child.namespaceURI === W_NS) {
        if (child.localName === "style") {
          const id = attr(child, "styleId");
          if (id !== null) {
            setAttr(child, "styleId", applyRename(id, rules));
          }
        }
        if (
          child.localName === "name" ||
          STYLE_REFERENCE_ELEMENTS.has(child.localName)
        ) {
          const value = attr(child, "val");
          if (value !== null) {
            setAttr(child, "val", applyRename(value, rules));
          }
        }
      }
      walk(child);
    }
  };
  walk(doc);
};

export const isElement = (node: slimdom.Node): node is slimdom.Element =>
  node.nodeType === 1;

/** OOXML attributes are namespaced; a prefixed read covers a serialized part. */
export const attr = (element: slimdom.Element, name: string): string | null =>
  element.getAttributeNS(W_NS, name) ?? element.getAttribute(`w:${name}`);

const setAttr = (
  element: slimdom.Element,
  name: string,
  value: string,
): void => {
  element.setAttributeNS(W_NS, `w:${name}`, value);
};

/** Direct child, not a descendant: `w:pPr` of this style, not of its children. */
export const childElement = (
  parent: slimdom.Element,
  localName: string,
): slimdom.Element | null => {
  for (const child of parent.childNodes) {
    if (
      isElement(child) &&
      child.namespaceURI === W_NS &&
      child.localName === localName
    ) {
      return child;
    }
  }
  return null;
};

const childElements = (
  parent: slimdom.Element,
  localName: string,
): slimdom.Element[] => {
  const found: slimdom.Element[] = [];
  for (const child of parent.childNodes) {
    if (
      isElement(child) &&
      child.namespaceURI === W_NS &&
      child.localName === localName
    ) {
      found.push(child);
    }
  }
  return found;
};

const intAttr = (
  element: slimdom.Element | null,
  name: string,
): number | null => {
  if (element === null) {
    return null;
  }
  const raw = attr(element, name);
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/**
 * A toggle property (`w:b`, `w:i`, `w:caps`) is on when present unless its
 * `w:val` says otherwise; absent means "inherit", which is why this returns
 * null rather than false.
 */
const toggle = (
  parent: slimdom.Element | null,
  localName: string,
): boolean | null => {
  if (parent === null) {
    return null;
  }
  const element = childElement(parent, localName);
  if (element === null) {
    return null;
  }
  const value = attr(element, "val");
  return value === null ? true : value !== "0" && value !== "false";
};

type NumberingLevel = {
  format: string;
  text: string;
  start: number;
  /** The style this level is linked to, when the list drives styles. */
  styleId: string | null;
};

export type NumberingDefinitions = {
  /** `w:numId` to its abstract definition's levels. */
  levelsByNumId: Map<number, Map<number, NumberingLevel>>;
};

const ROMAN_NUMERALS = [
  { value: 1000, numeral: "m" },
  { value: 900, numeral: "cm" },
  { value: 500, numeral: "d" },
  { value: 400, numeral: "cd" },
  { value: 100, numeral: "c" },
  { value: 90, numeral: "xc" },
  { value: 50, numeral: "l" },
  { value: 40, numeral: "xl" },
  { value: 10, numeral: "x" },
  { value: 9, numeral: "ix" },
  { value: 5, numeral: "v" },
  { value: 4, numeral: "iv" },
  { value: 1, numeral: "i" },
] as const;

const romanNumeral = (value: number): string => {
  let remaining = value;
  let text = "";
  for (const { value: unit, numeral } of ROMAN_NUMERALS) {
    while (remaining >= unit) {
      text += numeral;
      remaining -= unit;
    }
  }
  return text;
};

const ALPHABET_SIZE = 26;
/** `a`, the first letter Word counts with. */
const FIRST_LETTER_CODE_POINT = 97;

const letterNumeral = (value: number): string => {
  // Word cycles a, b, … z, aa, bb: the letter repeats rather than carrying.
  const index = (value - 1) % ALPHABET_SIZE;
  const repeats = Math.floor((value - 1) / ALPHABET_SIZE) + 1;
  return String.fromCodePoint(FIRST_LETTER_CODE_POINT + index).repeat(repeats);
};

/** One level's own counter as its format prints it. */
const renderCounter = (format: string, start: number): string => {
  switch (format) {
    case "decimal":
    case "decimalZero":
      return String(start);
    case "lowerLetter":
      return letterNumeral(start);
    case "upperLetter":
      return letterNumeral(start).toUpperCase();
    case "lowerRoman":
      return romanNumeral(start);
    case "upperRoman":
      return romanNumeral(start).toUpperCase();
    default:
      return "";
  }
};

const PLACEHOLDER = /%(?<level>\d)/gu;

/**
 * `w:lvlText` as a reader sees the first number of the level: "%1.%2" under
 * decimal levels reads "1.1", "(%4)" under lowerLetter reads "(a)". A bullet
 * keeps its literal character, which is what `w:lvlText` already holds.
 */
const renderNumberExample = (
  levels: Map<number, NumberingLevel>,
  level: number,
): string => {
  const own = levels.get(level);
  if (own === undefined) {
    return "";
  }
  return own.text.replaceAll(PLACEHOLDER, (match, _digit, _offset, _all) => {
    const index = Number.parseInt(match.slice(1), 10) - 1;
    const referenced = levels.get(index);
    return referenced === undefined
      ? ""
      : renderCounter(referenced.format, referenced.start);
  });
};

const readNumbering = (numberingXml: string | null): NumberingDefinitions => {
  const levelsByNumId = new Map<number, Map<number, NumberingLevel>>();
  if (numberingXml === null) {
    return { levelsByNumId };
  }
  const doc = slimdom.parseXmlDocument(numberingXml);
  const abstracts = new Map<number, Map<number, NumberingLevel>>();
  for (const abstract of doc.getElementsByTagNameNS(W_NS, "abstractNum")) {
    const abstractId = intAttr(abstract, "abstractNumId");
    if (abstractId === null) {
      continue;
    }
    const levels = new Map<number, NumberingLevel>();
    for (const level of childElements(abstract, "lvl")) {
      const ilvl = intAttr(level, "ilvl");
      if (ilvl === null) {
        continue;
      }
      levels.set(ilvl, {
        format: attrOfNullable(childElement(level, "numFmt"), "val") ?? "none",
        text: attrOfNullable(childElement(level, "lvlText"), "val") ?? "",
        start: intAttr(childElement(level, "start"), "val") ?? 1,
        styleId: attrOfNullable(childElement(level, "pStyle"), "val"),
      });
    }
    abstracts.set(abstractId, levels);
  }
  for (const num of doc.getElementsByTagNameNS(W_NS, "num")) {
    const numId = intAttr(num, "numId");
    const abstractId = intAttr(childElement(num, "abstractNumId"), "val");
    if (numId === null || abstractId === null) {
      continue;
    }
    const levels = abstracts.get(abstractId);
    if (levels !== undefined) {
      levelsByNumId.set(numId, levels);
    }
  }
  return { levelsByNumId };
};

type RawStyle = {
  id: string;
  name: string;
  basedOn: string | null;
  pPr: slimdom.Element | null;
  rPr: slimdom.Element | null;
};

const EMPTY_FORMATTING: StyleFormatting = {
  font: null,
  sizePt: null,
  bold: false,
  italic: false,
  allCaps: false,
  alignment: null,
  indentLeftTwips: null,
  indentFirstLineTwips: null,
  indentHangingTwips: null,
  spaceBeforeTwips: null,
  spaceAfterTwips: null,
  outlineLevel: null,
  numbering: null,
};

/**
 * What one layer of properties says about numbering.
 *
 * `w:numId` 0 is not silence: WordprocessingML reserves it for "no
 * numbering", and it cancels the list a `w:basedOn` ancestor declared. Read
 * as an absent `w:numPr` it would be overwritten by the inherited value and a
 * style that switches numbering off would print numbers, so the two states are
 * separate branches every reader has to answer for.
 */
export type NumberingDeclaration =
  | { type: "absent" }
  | { type: "disabled" }
  | { type: "reference"; numId: number; level: number | null };

/** The reserved `w:numId` that turns numbering off instead of naming a list. */
const NUMBERING_DISABLED_NUM_ID = 0;

export const numberingDeclaration = (
  pPr: slimdom.Element | null,
): NumberingDeclaration => {
  const numPr = pPr === null ? null : childElement(pPr, "numPr");
  if (numPr === null) {
    return { type: "absent" };
  }
  const numId = intAttr(childElement(numPr, "numId"), "val");
  if (numId === null) {
    return { type: "absent" };
  }
  if (numId === NUMBERING_DISABLED_NUM_ID) {
    return { type: "disabled" };
  }
  return {
    type: "reference",
    numId,
    level: intAttr(childElement(numPr, "ilvl"), "val"),
  };
};

/**
 * One layer of properties over what it inherits. A property absent from this
 * layer keeps the inherited value, which is what makes `basedOn` a cascade
 * rather than a replacement.
 */
const applyLayer = (
  inherited: StyleFormatting,
  { pPr, rPr }: { pPr: slimdom.Element | null; rPr: slimdom.Element | null },
): StyleFormatting => {
  const indent = pPr === null ? null : childElement(pPr, "ind");
  const spacing = pPr === null ? null : childElement(pPr, "spacing");
  const fonts = rPr === null ? null : childElement(rPr, "rFonts");
  const size = intAttr(rPr === null ? null : childElement(rPr, "sz"), "val");
  const outline = intAttr(
    pPr === null ? null : childElement(pPr, "outlineLvl"),
    "val",
  );
  return {
    font: (fonts === null ? null : attr(fonts, "ascii")) ?? inherited.font,
    sizePt: size === null ? inherited.sizePt : size / HALF_POINTS_PER_POINT,
    bold: toggle(rPr, "b") ?? inherited.bold,
    italic: toggle(rPr, "i") ?? inherited.italic,
    allCaps: toggle(rPr, "caps") ?? inherited.allCaps,
    alignment:
      attrOfNullable(pPr === null ? null : childElement(pPr, "jc"), "val") ??
      inherited.alignment,
    indentLeftTwips: intAttr(indent, "left") ?? inherited.indentLeftTwips,
    indentFirstLineTwips:
      intAttr(indent, "firstLine") ?? inherited.indentFirstLineTwips,
    indentHangingTwips:
      intAttr(indent, "hanging") ?? inherited.indentHangingTwips,
    spaceBeforeTwips: intAttr(spacing, "before") ?? inherited.spaceBeforeTwips,
    spaceAfterTwips: intAttr(spacing, "after") ?? inherited.spaceAfterTwips,
    outlineLevel: outline ?? inherited.outlineLevel,
    numbering: inherited.numbering,
  };
};

const attrOfNullable = (
  element: slimdom.Element | null,
  name: string,
): string | null => (element === null ? null : attr(element, name));

/** The chain root first, so a nearer style's properties are applied last. */
const inheritanceChain = (
  styles: Map<string, RawStyle>,
  id: string,
): RawStyle[] => {
  const chain: RawStyle[] = [];
  const seen = new Set<string>();
  let current = styles.get(id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current =
      current.basedOn === null ? undefined : styles.get(current.basedOn);
  }
  return chain;
};

export type ExtractStyleCatalogueOptions = {
  stylesXml: string;
  numberingXml: string | null;
  documentXml: string;
  /** Applied to style ids and display names before anything else reads them. */
  rename?: readonly RenameRule[] | undefined;
};

type StyleUsage = { count: number; examples: string[] };

/** What a style the document never uses reads as. */
const UNUSED_STYLE: StyleUsage = { count: 0, examples: [] };

type DocumentUsage = {
  byStyle: Map<string, StyleUsage>;
  defaultStyleId: string;
};

const truncate = (text: string): string => {
  const points = Array.from(text);
  return points.length <= EXAMPLE_MAX_CHARS
    ? text
    : `${points.slice(0, EXAMPLE_MAX_CHARS - 1).join("")}…`;
};

const readUsage = (
  documentXml: string,
  defaultStyleId: string,
): DocumentUsage => {
  const doc = slimdom.parseXmlDocument(documentXml);
  const byStyle = new Map<string, StyleUsage>();
  for (const paragraph of doc.getElementsByTagNameNS(W_NS, "p")) {
    const text = paragraphText(paragraph).trim();
    if (text.length === 0) {
      continue;
    }
    const pPr = childElement(paragraph, "pPr");
    const styleId =
      attrOfNullable(
        pPr === null ? null : childElement(pPr, "pStyle"),
        "val",
      ) ?? defaultStyleId;
    const seen = byStyle.get(styleId);
    if (seen === undefined) {
      byStyle.set(styleId, { count: 1, examples: [truncate(text)] });
      continue;
    }
    seen.count += 1;
    if (seen.examples.length < MAX_EXAMPLES) {
      seen.examples.push(truncate(text));
    }
  }
  return { byStyle, defaultStyleId };
};

/** A table of contents is generated, so its styles are never a drafting choice. */
const isTableOfContentsStyle = ({ id, name }: { id: string; name: string }) =>
  /^toc/iu.test(id) || /^toc/iu.test(name.replaceAll(" ", ""));

/** One paragraph style, with its formatting already resolved. */
type StyleDefinition = {
  id: string;
  name: string;
  basedOn: string | null;
  formatting: StyleFormatting;
};

export type StyleDefinitions = {
  /** The style a paragraph without a `w:pStyle` carries. */
  defaultStyleId: string;
  byId: Map<string, StyleDefinition>;
  /** Kept so a paragraph's own `w:numPr` resolves against the same lists. */
  numbering: NumberingDefinitions;
};

export type ReadStyleDefinitionsOptions = {
  /**
   * Null where the package carries no `word/styles.xml`. Word opens such a
   * document with every paragraph on the default style; so does this.
   */
  stylesXml: string | null;
  numberingXml: string | null;
  rename?: readonly RenameRule[] | undefined;
};

/**
 * Every paragraph style of a document, each resolved through its `basedOn`
 * chain and its numbering level. Both sides of a conversion read styles this
 * way: the style set to build its catalogue, the converted document to say
 * what each paragraph was before.
 */
export const readStyleDefinitions = ({
  stylesXml,
  numberingXml,
  rename = [],
}: ReadStyleDefinitionsOptions): StyleDefinitions => {
  const numbering = readNumbering(
    numberingXml === null ? null : renameStyleReferences(numberingXml, rename),
  );
  if (stylesXml === null) {
    return { defaultStyleId: DEFAULT_STYLE_ID, byId: new Map(), numbering };
  }
  const stylesDoc = slimdom.parseXmlDocument(stylesXml);
  renameStylesInDocument(stylesDoc, rename);

  const raw = new Map<string, RawStyle>();
  let defaultStyleId = DEFAULT_STYLE_ID;
  for (const style of stylesDoc.getElementsByTagNameNS(W_NS, "style")) {
    const id = attr(style, "styleId");
    if (id === null || attr(style, "type") !== "paragraph") {
      continue;
    }
    if (attr(style, "default") === "1") {
      defaultStyleId = id;
    }
    raw.set(id, {
      id,
      name: attrOfNullable(childElement(style, "name"), "val") ?? id,
      basedOn: attrOfNullable(childElement(style, "basedOn"), "val"),
      pPr: childElement(style, "pPr"),
      rPr: childElement(style, "rPr"),
    });
  }

  const docDefaults = stylesDoc
    .getElementsByTagNameNS(W_NS, "docDefaults")
    .at(0);
  const runDefaults =
    docDefaults === undefined ? null : childElement(docDefaults, "rPrDefault");
  const base = applyLayer(EMPTY_FORMATTING, {
    pPr: null,
    rPr: runDefaults === null ? null : childElement(runDefaults, "rPr"),
  });

  const byId = new Map<string, StyleDefinition>();
  for (const style of raw.values()) {
    let formatting = base;
    // Root first, so the nearest layer that speaks wins: a `disabled` layer
    // stops what its ancestors declared instead of deferring to it.
    let declaration: NumberingDeclaration = { type: "absent" };
    for (const layer of inheritanceChain(raw, style.id)) {
      formatting = applyLayer(formatting, layer);
      const own = numberingDeclaration(layer.pPr);
      if (own.type !== "absent") {
        declaration = own;
      }
    }
    byId.set(style.id, {
      id: style.id,
      name: style.name,
      basedOn: style.basedOn,
      formatting: {
        ...formatting,
        numbering: resolveNumbering({
          numbering,
          declaration,
          styleId: style.id,
        }),
      },
    });
  }
  return { defaultStyleId, byId, numbering };
};

export const extractStyleCatalogue = ({
  stylesXml,
  numberingXml,
  documentXml,
  rename = [],
}: ExtractStyleCatalogueOptions): StyleCatalogue => {
  const definitions = readStyleDefinitions({
    stylesXml,
    numberingXml,
    rename,
  });
  const usage = readUsage(
    renameStyleReferences(documentXml, rename),
    definitions.defaultStyleId,
  );

  const styles: CatalogueStyle[] = [];
  for (const { id, name, basedOn, formatting } of definitions.byId.values()) {
    if (isTableOfContentsStyle({ id, name })) {
      continue;
    }
    // A stored style set is content-free, so usage cannot decide membership:
    // the catalogue is what the set defines, and the guide picks what to use.
    const seen = usage.byStyle.get(id) ?? UNUSED_STYLE;
    styles.push({
      id,
      name,
      basedOn,
      usageCount: seen.count,
      formatting,
      examples: seen.examples,
    });
  }
  styles.sort(
    (left, right) =>
      right.usageCount - left.usageCount || (left.id < right.id ? -1 : 1),
  );
  return {
    hash: catalogueHash(styles),
    defaultStyleId: definitions.defaultStyleId,
    styles,
  };
};

/** A renamed copy of a part: the same XML with every style reference rewritten. */
export const renameStyleReferences = (
  xml: string,
  rename: readonly RenameRule[],
): string => {
  if (rename.length === 0) {
    return xml;
  }
  const doc = slimdom.parseXmlDocument(xml);
  renameStylesInDocument(doc, rename);
  return slimdom.serializeToWellFormedString(doc);
};

export const resolveNumbering = ({
  numbering,
  declaration,
  styleId,
}: {
  numbering: NumberingDefinitions;
  declaration: NumberingDeclaration;
  styleId: string;
}): StyleNumbering | null => {
  switch (declaration.type) {
    case "absent":
    case "disabled":
      return null;
    case "reference": {
      const levels = numbering.levelsByNumId.get(declaration.numId);
      if (levels === undefined) {
        return null;
      }
      // A multilevel list that drives styles names each style on its own
      // level; the paragraph's `w:ilvl` wins where the style carries one, and
      // a list that names nothing falls back to its first level.
      const linked = [...levels.entries()].find(
        ([, level]) => level.styleId === styleId,
      );
      const level = declaration.level ?? linked?.at(0) ?? 0;
      const resolvedLevel = typeof level === "number" ? level : 0;
      const own = levels.get(resolvedLevel);
      return {
        numId: declaration.numId,
        level: resolvedLevel,
        format: own?.format ?? "none",
        example: renderNumberExample(levels, resolvedLevel),
      };
    }
    default:
      declaration satisfies never;
      return panic("Unhandled numbering declaration");
  }
};

/**
 * The ids, names and formatting of a catalogue, not its examples or counts:
 * a guide describes what the styles are, so a re-uploaded file with the same
 * styles keeps its guide and a changed hierarchy does not.
 */
const catalogueHash = (styles: readonly CatalogueStyle[]): string => {
  const canonical = [...styles]
    .map(({ id, name, formatting }) => ({ id, name, formatting }))
    .sort((left, right) => (left.id < right.id ? -1 : 1));
  return new Bun.CryptoHasher("sha256")
    .update(stableStringify(canonical))
    .digest("hex");
};
