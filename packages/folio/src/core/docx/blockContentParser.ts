/**
 * Shared OOXML block-content parser.
 *
 * The document body, headers, footers, and SDT content all expose the same
 * block-level model: paragraphs, tables, and nested structured document tags.
 * Keeping the parser shared prevents body-only fixes, especially for drawings
 * like text boxes that can appear in headers and footers too.
 */

import type {
  BlockContent,
  BlockSdt,
  BookmarkEnd,
  BookmarkStart,
  MediaFile,
  Paragraph,
  RelationshipMap,
  Run,
  Shape,
  ShapeContent,
  Theme,
} from "../types/document";
import { parseBookmarkEnd, parseBookmarkStart } from "./bookmarkParser";
import {
  appendBookmarkMarkerToLastParagraphInBlocks,
  prependBookmarkMarkersToFirstParagraphInBlocks,
} from "./bookmarkPlacement";
import type { BookmarkMarker } from "./bookmarkPlacement";
import { convertBulletToUnicode } from "./bulletMarkers";
import type { NumberingMap } from "./numberingParser";
import { parseParagraph } from "./paragraphParser";
import { parseSdtProperties } from "./sdtProperties";
import type { StyleMap } from "./styleParser";
import { parseTable } from "./tableParser";
import {
  getTextBoxContentElement,
  isTextBoxDrawing,
  parseTextBox,
  parseTextBoxContent,
} from "./textBoxParser";
import {
  elementToXml,
  findChild,
  findDeep,
  getChildElements,
  getLocalName,
  type XmlElement,
} from "./xmlParser";

type ParseBlockContentOptions = {
  inHeaderFooter?: boolean;
};

const toRoman = (numParam: number): string => {
  let num = numParam;
  const romanNumerals: [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];

  let result = "";
  for (const [value, symbol] of romanNumerals) {
    while (num >= value) {
      result += symbol;
      num -= value;
    }
  }
  return result;
};

const toRepeatedLetter = (value: number, baseCodePoint: number): string => {
  if (value <= 0) {
    return "0";
  }
  const zeroBased = value - 1;
  const letter = String.fromCodePoint(baseCodePoint + (zeroBased % 26));
  return letter.repeat(Math.floor(zeroBased / 26) + 1);
};

const formatNumber = (value: number, numFmt: string): string => {
  switch (numFmt) {
    case "decimal":
    case "decimalZero":
      return String(value);
    case "lowerLetter":
      return toRepeatedLetter(value, 97);
    case "upperLetter":
      return toRepeatedLetter(value, 65);
    case "lowerRoman":
      return toRoman(value).toLowerCase();
    case "upperRoman":
      return toRoman(value);
    case "bullet":
      return "\u2022";
    default:
      return String(value);
  }
};

const computeListMarker = (
  paragraph: Paragraph,
  numbering: NumberingMap | null,
  listCounters: Map<number, number[]>,
  abstractCounters: Map<number, number[]>,
): void => {
  const listRendering = paragraph.listRendering;
  if (!listRendering || !numbering) {
    return;
  }

  const { numId, level } = listRendering;
  if (numId === 0) {
    return;
  }

  if (!listCounters.has(numId)) {
    listCounters.set(numId, Array.from<number>({ length: 9 }).fill(0));
  }

  const counters = listCounters.get(numId);
  if (!counters) {
    return;
  }

  const abstractNumId = numbering.getAbstractNumId(numId);
  if (abstractNumId !== null && level > 0) {
    const latestAbstractCounters = abstractCounters.get(abstractNumId);
    const missingParentCounters = counters
      .slice(0, level)
      .every((value) => value === 0);
    if (latestAbstractCounters && missingParentCounters) {
      for (let i = 0; i < level; i += 1) {
        counters[i] = latestAbstractCounters[i] ?? 0;
      }
    }
  }

  counters[level] = (counters[level] || 0) + 1;

  for (let i = level + 1; i < counters.length; i += 1) {
    counters[i] = 0;
  }

  // Word's default LISTNUM field advances the counter at one ilvl deeper
  // than the host paragraph. Mirror the toFlowBlocks logic here so the
  // marker substituted at parse time agrees with the renderer's counters —
  // otherwise a follow-up paragraph at that depth picks up the stale,
  // pre-substituted "(a)" instead of "(b)".
  const childAdvances = listRendering.implicitChildLevelAdvances ?? 0;
  if (childAdvances > 0 && level + 1 < counters.length) {
    counters[level + 1] = (counters[level + 1] ?? 0) + childAdvances;
  }

  if (abstractNumId !== null) {
    abstractCounters.set(abstractNumId, [...counters]);
  }

  const pattern = listRendering.marker;

  if (listRendering.isBullet) {
    listRendering.marker = convertBulletToUnicode(pattern || "");
    return;
  }

  let computedMarker = pattern;
  const currentLevelInfo = numbering.getLevel(numId, level);
  const useLegalNumbering =
    currentLevelInfo?.isLgl === true || listRendering.isLegal === true;

  for (let lvl = 0; lvl <= level; lvl += 1) {
    const placeholder = `%${lvl + 1}`;
    if (computedMarker.includes(placeholder)) {
      const value = counters[lvl] ?? 0;
      const levelInfo = numbering.getLevel(numId, lvl);
      const formatted = formatNumber(
        value,
        useLegalNumbering ? "decimal" : levelInfo?.numFmt || "decimal",
      );
      computedMarker = computedMarker.replaceAll(placeholder, formatted);
    }
  }

  listRendering.marker = computedMarker;
};

const enrichParagraphTextBoxes = (
  paragraph: Paragraph,
  paraXml: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
): void => {
  if (paragraph.content.length === 0) {
    return;
  }

  const xmlChildren = getChildElements(paraXml);
  let parsedIndex = 0;
  let lastConsumedRun: Run | undefined;

  for (const xmlChild of xmlChildren) {
    if (getLocalName(xmlChild.name ?? "") !== "r") {
      if (
        parsedIndex < paragraph.content.length &&
        paragraph.content[parsedIndex]?.type !== "run"
      ) {
        parsedIndex += 1;
      }
      continue;
    }

    const { textBoxDrawings, hasNonTextBoxContent } =
      scanRunForTextBoxDrawings(xmlChild);

    const parsedContent = paragraph.content[parsedIndex];
    const parsedRun: Run | undefined =
      parsedContent?.type === "run" ? parsedContent : undefined;
    const targetRun =
      parsedRun ?? (hasNonTextBoxContent ? lastConsumedRun : undefined);

    for (const runEl of textBoxDrawings) {
      const textBox = parseTextBox(runEl);
      if (!textBox) {
        continue;
      }

      const wsp = findDeep(runEl, "wps", "wsp");
      if (wsp) {
        const txbxContentEl = getTextBoxContentElement(wsp);
        if (txbxContentEl) {
          textBox.content = parseTextBoxContent(
            txbxContentEl,
            parseParagraph,
            null,
            styles,
            theme,
            numbering,
            rels ?? undefined,
            media ?? undefined,
          );
        }
      }

      const shape: Shape = {
        type: "shape",
        shapeType: "textBox",
        size: textBox.size,
        ...(textBox.position !== undefined
          ? { position: textBox.position }
          : {}),
        ...(textBox.wrap !== undefined ? { wrap: textBox.wrap } : {}),
        ...(textBox.fill !== undefined ? { fill: textBox.fill } : {}),
        ...(textBox.outline !== undefined ? { outline: textBox.outline } : {}),
        textBody: {
          content: textBox.content,
          ...(textBox.margins !== undefined
            ? { margins: textBox.margins }
            : {}),
        },
      };
      if (textBox.id) {
        shape.id = textBox.id;
      }

      const shapeContent: ShapeContent = { type: "shape", shape };

      if (targetRun && hasNonTextBoxContent) {
        targetRun.content.push(shapeContent);
      } else {
        const newRun: Run = { type: "run", content: [shapeContent] };
        paragraph.content.splice(parsedIndex, 0, newRun);
        lastConsumedRun = newRun;
        parsedIndex += 1;
      }
    }

    if (hasNonTextBoxContent && parsedRun) {
      lastConsumedRun = parsedRun;
      parsedIndex += 1;
    }
  }
};

type TextBoxRunScan = {
  textBoxDrawings: XmlElement[];
  hasNonTextBoxContent: boolean;
};

const scanRunForTextBoxDrawings = (xmlRun: XmlElement): TextBoxRunScan => {
  const textBoxDrawings: XmlElement[] = [];
  let hasNonTextBoxContent = false;

  const visitDrawing = (drawingEl: XmlElement): void => {
    if (isTextBoxDrawing(drawingEl)) {
      textBoxDrawings.push(drawingEl);
      return;
    }
    hasNonTextBoxContent = true;
  };

  for (const el of getChildElements(xmlRun)) {
    const name = getLocalName(el.name ?? "");
    if (name === "rPr") {
      continue;
    }
    if (name === "drawing") {
      visitDrawing(el);
      continue;
    }
    if (name === "AlternateContent") {
      const branches = getChildElements(el);
      const choice = branches.find(
        (branch) => getLocalName(branch.name ?? "") === "Choice",
      );
      const fallback = branches.find(
        (branch) => getLocalName(branch.name ?? "") === "Fallback",
      );
      const tryBranch = (branch: XmlElement | undefined): boolean => {
        if (!branch) {
          return false;
        }
        let found = false;
        for (const innerEl of getChildElements(branch)) {
          if (getLocalName(innerEl.name ?? "") === "drawing") {
            visitDrawing(innerEl);
            found = true;
          }
        }
        return found;
      };
      let foundInBranch = tryBranch(choice);
      if (!foundInBranch) {
        foundInBranch = tryBranch(fallback);
      }
      if (!foundInBranch) {
        hasNonTextBoxContent = true;
      }
      continue;
    }
    hasNonTextBoxContent = true;
  }

  return { textBoxDrawings, hasNonTextBoxContent };
};

type ParseBlockContentState = {
  listCounters: Map<number, number[]>;
  abstractCounters: Map<number, number[]>;
  options: ParseBlockContentOptions | undefined;
};

export const parseBlockContent = (
  parent: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
  options?: ParseBlockContentOptions,
): BlockContent[] =>
  parseBlockContentWithState(parent, styles, theme, numbering, rels, media, {
    listCounters: new Map(),
    abstractCounters: new Map(),
    options,
  });

const parseBlockContentWithState = (
  parent: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
  state: ParseBlockContentState,
): BlockContent[] => {
  const content: BlockContent[] = [];
  const children = getChildElements(parent);
  const pendingBookmarkMarkers: BookmarkMarker[] = [];

  for (const child of children) {
    const name = child.name ?? "";
    const localName = getLocalName(name);

    if (localName === "p") {
      const paragraph = parseParagraph(
        child,
        styles,
        theme,
        numbering,
        rels,
        media,
        state.options,
      );
      prependPendingBookmarkMarkers(paragraph, pendingBookmarkMarkers);
      enrichParagraphTextBoxes(
        paragraph,
        child,
        styles,
        theme,
        numbering,
        rels,
        media,
      );
      computeListMarker(
        paragraph,
        numbering,
        state.listCounters,
        state.abstractCounters,
      );
      content.push(paragraph);
      continue;
    }

    if (localName === "tbl") {
      const table = parseTable(
        child,
        styles,
        theme,
        numbering,
        rels,
        media,
        state.options,
      );
      if (
        prependBookmarkMarkersToFirstParagraphInBlocks(
          [table],
          pendingBookmarkMarkers,
        )
      ) {
        pendingBookmarkMarkers.length = 0;
      }
      content.push(table);
      continue;
    }

    if (localName === "sdt") {
      const sdtPr = findChild(child, "w", "sdtPr");
      const sdtEndPr = findChild(child, "w", "sdtEndPr");
      const sdtContent = findChild(child, "w", "sdtContent");
      const properties = parseSdtProperties(sdtPr, sdtEndPr);
      // Capture non-content direct children of <w:sdt> (bookmark / comment /
      // tracked-change / custom XML range markers — MS-OE376 §2.5.2.30) so a
      // comment thread or tracked change that crosses an SDT boundary
      // doesn't lose a delimiter on round-trip. Split by position relative
      // to sdtContent.
      const captured = captureSdtSiblingMarkers(child);
      if (captured.before.length > 0) {
        properties.rawSdtChildrenBeforeContent = captured.before;
      }
      if (captured.after.length > 0) {
        properties.rawSdtChildrenAfterContent = captured.after;
      }
      const blockSdt: BlockSdt = {
        type: "blockSdt",
        properties,
        content: sdtContent
          ? parseBlockContentWithState(
              sdtContent,
              styles,
              theme,
              numbering,
              rels,
              media,
              state,
            )
          : [],
      };
      if (
        prependBookmarkMarkersToFirstParagraphInBlocks(
          blockSdt.content,
          pendingBookmarkMarkers,
        )
      ) {
        pendingBookmarkMarkers.length = 0;
      }
      content.push(blockSdt);
      continue;
    }

    if (localName === "bookmarkStart" || localName === "bookmarkEnd") {
      const marker = parseBookmarkMarker(child, localName);
      if (!appendBookmarkMarkerToLastParagraphInBlocks(content, marker)) {
        pendingBookmarkMarkers.push(marker);
      }
    }
  }

  if (pendingBookmarkMarkers.length > 0) {
    content.push({
      type: "paragraph",
      content: [...pendingBookmarkMarkers],
    });
  }

  return content;
};

/**
 * Walk a `<w:sdt>` element's direct children and return the verbatim XML
 * for every child that is NOT `<w:sdtPr>`, `<w:sdtEndPr>`, or
 * `<w:sdtContent>` — split by position relative to sdtContent.
 *
 * Per MS-OE376 §2.5.2.30, Word emits 16 range-marker elements (bookmark,
 * comment, custom XML, tracked-change ranges) as direct sdt siblings of
 * sdtContent. Without preserving them, a comment thread or tracked
 * change that crosses an SDT boundary loses a delimiter when folio
 * serializes the parsed model back out.
 */
const captureSdtSiblingMarkers = (
  sdt: XmlElement,
): { before: string; after: string } => {
  const beforeParts: string[] = [];
  const afterParts: string[] = [];
  let sawContent = false;
  for (const ch of sdt.elements ?? []) {
    if (ch.type !== "element" || !ch.name) {
      continue;
    }
    const local = getLocalName(ch.name);
    if (local === "sdtPr" || local === "sdtEndPr") {
      continue;
    }
    if (local === "sdtContent") {
      sawContent = true;
      continue;
    }
    const xml = elementToXml(ch);
    if (sawContent) {
      afterParts.push(xml);
    } else {
      beforeParts.push(xml);
    }
  }
  return { before: beforeParts.join(""), after: afterParts.join("") };
};

const parseBookmarkMarker = (
  child: XmlElement,
  localName: "bookmarkStart" | "bookmarkEnd",
): BookmarkStart | BookmarkEnd => {
  if (localName === "bookmarkStart") {
    return parseBookmarkStart(child);
  }
  return parseBookmarkEnd(child);
};

const prependPendingBookmarkMarkers = (
  paragraph: Paragraph,
  pendingBookmarkMarkers: BookmarkMarker[],
): void => {
  if (pendingBookmarkMarkers.length === 0) {
    return;
  }

  paragraph.content.unshift(...pendingBookmarkMarkers);
  pendingBookmarkMarkers.length = 0;
};
