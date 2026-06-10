/** Extract plain-text and Markdown content from a DOCX for AI context. */

import * as slimdom from "slimdom";

import type { DocxArchive } from "@/api/lib/docx-archive";
import { loadDocxArchive } from "@/api/lib/docx-archive";

import { HEADER_FOOTER_RE, isElement, W_NS } from "./ooxml";
import type {
  BlockDirectiveKind,
  ExtractedDocument,
  ExtractedParagraph,
  ParagraphSource,
} from "./types";

// ── Directive detection ─────────────────────────────────

/**
 * Matches a block directive as the sole paragraph content.
 * Intentionally duplicated from block-directives.ts: the two
 * modules serve different purposes and should not depend on
 * each other.
 */
const DIRECTIVE_RE =
  // oxlint-disable-next-line sonarjs/slow-regex -- DOCX directive text is one paragraph collected from OOXML
  /^\s*\{\{(#if|#elseif|#else|#each|\/if|\/each)\s*(.*?)\}\}\s*$/u;

const DIRECTIVE_KIND_MAP: Record<string, BlockDirectiveKind> = {
  "#if": "if",
  "#elseif": "elseif",
  "#else": "else",
  "#each": "each",
  "/if": "endif",
  "/each": "endeach",
};

/** Concatenate run text, skipping tracked deletions and preserving explicit breaks. */
const collectText = (el: slimdom.Element): string => {
  let text = "";
  const walk = (node: slimdom.Node) => {
    if (!isElement(node)) {
      return;
    }
    if (node.localName === "t" && node.namespaceURI === W_NS) {
      text += node.textContent ?? "";
    } else if (node.localName === "br" && node.namespaceURI === W_NS) {
      text += "\n";
    } else if (node.localName === "tab" && node.namespaceURI === W_NS) {
      text += "\t";
    } else if (
      node.localName !== "delText" &&
      node.localName !== "del" &&
      node.localName !== "moveFrom"
    ) {
      for (const c of node.childNodes) {
        walk(c);
      }
    }
  };
  walk(el);
  return text;
};

type ParagraphProps = {
  style?: string | undefined;
  alignment?: "left" | "center" | "right" | "both" | undefined;
};

/** Read paragraph properties from `w:pPr`. */
const readParagraphProps = (p: slimdom.Element): ParagraphProps => {
  const props: ParagraphProps = {};
  for (const child of p.childNodes) {
    if (!isElement(child)) {
      continue;
    }
    if (child.localName !== "pPr" || child.namespaceURI !== W_NS) {
      continue;
    }
    for (const inner of child.childNodes) {
      if (!isElement(inner)) {
        continue;
      }
      if (inner.localName === "pStyle" && inner.namespaceURI === W_NS) {
        props.style =
          inner.getAttributeNS(W_NS, "val") ??
          inner.getAttribute("w:val") ??
          undefined;
      }
      if (inner.localName === "jc" && inner.namespaceURI === W_NS) {
        const val =
          inner.getAttributeNS(W_NS, "val") ?? inner.getAttribute("w:val");
        if (val === "center" || val === "right" || val === "both") {
          props.alignment = val;
        }
      }
    }
    break;
  }
  return props;
};

const readAttr = (el: slimdom.Element, local: string): string | undefined =>
  el.getAttributeNS(W_NS, local) ?? el.getAttribute(`w:${local}`) ?? undefined;

type RunMetrics = {
  bold: boolean;
  fontSize?: number | undefined;
  chars: number;
};

/** Read bold and font size from runs in a paragraph. */
const readRunMetrics = (p: slimdom.Element): RunMetrics[] => {
  const runs: RunMetrics[] = [];
  for (const child of p.childNodes) {
    if (!isElement(child)) {
      continue;
    }
    if (child.localName !== "r" || child.namespaceURI !== W_NS) {
      continue;
    }
    let bold = false;
    let fontSize: number | undefined;
    let chars = 0;
    for (const inner of child.childNodes) {
      if (!isElement(inner)) {
        continue;
      }
      if (inner.localName === "rPr" && inner.namespaceURI === W_NS) {
        for (const prop of inner.childNodes) {
          if (!isElement(prop)) {
            continue;
          }
          if (prop.localName === "b" && prop.namespaceURI === W_NS) {
            const val = readAttr(prop, "val");
            bold = val !== "0" && val !== "false";
          }
          if (prop.localName === "sz" && prop.namespaceURI === W_NS) {
            const val = readAttr(prop, "val");
            if (val) {
              fontSize = Number.parseInt(val, 10) || undefined;
            }
          }
        }
      }
      if (inner.localName === "t" && inner.namespaceURI === W_NS) {
        chars += (inner.textContent ?? "").length;
      }
    }
    if (chars > 0) {
      runs.push({ bold, fontSize, chars });
    }
  }
  return runs;
};

// ── Container extraction ─────────────────────────────────

/**
 * Extract paragraphs from a container element (w:body,
 * w:hdr, or w:ftr), tagging each with a source label.
 */
const extractParagraphsFromContainer = (
  container: slimdom.Element,
  source: ParagraphSource,
  startIndex: number,
): { paragraphs: ExtractedParagraph[]; chars: number } => {
  const paragraphs: ExtractedParagraph[] = [];
  let chars = 0;
  let index = startIndex;

  // Descendant paragraphs, not just direct children: document text
  // commonly sits inside tables (w:tbl/w:tr/w:tc) or content controls
  // (w:sdt), and discovery (`discover-template.ts`) already indexes
  // paragraphs this way, so extraction must enumerate the same set or
  // table content stays invisible to version diffs and AI context.
  for (const child of container.getElementsByTagNameNS(W_NS, "p")) {
    const text = collectText(child);
    const { style, alignment } = readParagraphProps(child);

    const entry: ExtractedParagraph = { index, text, source };
    if (style) {
      entry.style = style;
    }
    if (alignment) {
      entry.alignment = alignment;
    }

    const runs = readRunMetrics(child);
    if (runs.length > 0) {
      const totalCharsInRuns = runs.reduce((s, r) => s + r.chars, 0);
      const boldChars = runs.reduce((s, r) => s + (r.bold ? r.chars : 0), 0);
      if (boldChars > totalCharsInRuns / 2) {
        entry.bold = true;
      }
      const firstSize = runs.find((r) => (r.fontSize ?? 0) > 0)?.fontSize;
      if ((firstSize ?? 0) > 0) {
        entry.fontSize = firstSize;
      }
    }

    const dm = DIRECTIVE_RE.exec(text);
    if (dm) {
      entry.isDirective = true;
      const tag = dm[1];
      const expr = dm[2];
      if (tag !== undefined) {
        entry.directiveKind = DIRECTIVE_KIND_MAP[tag];
      }
      if (expr !== undefined) {
        entry.directiveExpression = expr.trim();
      }
    }

    paragraphs.push(entry);
    chars += text.length;
    index++;
  }

  return { paragraphs, chars };
};

/**
 * Extract paragraphs from all header/footer XML entries in
 * the archive, sorted by file name for deterministic ordering.
 */
const extractHeaderFooterParagraphs = async (
  archive: DocxArchive,
  source: ParagraphSource,
  rootTag: string,
  startIndex: number,
): Promise<{ paragraphs: ExtractedParagraph[]; chars: number }> => {
  const chunks: ExtractedParagraph[][] = [];
  let chars = 0;
  let index = startIndex;

  const prefix = `word/${source === "header" ? "header" : "footer"}`;
  const entries = Object.keys(archive.zip.files)
    .filter((path) => HEADER_FOOTER_RE.test(path) && path.startsWith(prefix))
    .toSorted();

  for (const path of entries) {
    const xml = await archive.readEntryString(path);
    if (xml === null) {
      continue;
    }

    const doc = slimdom.parseXmlDocument(xml);
    const container = doc.getElementsByTagNameNS(W_NS, rootTag).at(0);

    if (!container) {
      continue;
    }

    const result = extractParagraphsFromContainer(container, source, index);
    chunks.push(result.paragraphs);
    chars += result.chars;
    index += result.paragraphs.length;
  }

  return { paragraphs: chunks.flat(), chars };
};

// ── Public API ───────────────────────────────────────────

export const extractText = async (
  docxBytes: Uint8Array,
): Promise<ExtractedDocument> => {
  const archive = await loadDocxArchive(docxBytes);
  const emptyResult: ExtractedDocument = {
    paragraphs: [],
    charCount: 0,
    view: "accepted",
  };

  const xml = await archive.readEntryString("word/document.xml");
  if (xml === null) {
    return emptyResult;
  }

  const doc = slimdom.parseXmlDocument(xml);

  const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);
  if (!body) {
    return emptyResult;
  }

  // Extract headers (before body)
  const headers = await extractHeaderFooterParagraphs(
    archive,
    "header",
    "hdr",
    0,
  );

  // Extract body
  const bodyResult = extractParagraphsFromContainer(
    body,
    "body",
    headers.paragraphs.length,
  );

  // Extract footers (after body)
  const footers = await extractHeaderFooterParagraphs(
    archive,
    "footer",
    "ftr",
    headers.paragraphs.length + bodyResult.paragraphs.length,
  );

  const paragraphs = [
    ...headers.paragraphs,
    ...bodyResult.paragraphs,
    ...footers.paragraphs,
  ];
  const charCount = headers.chars + bodyResult.chars + footers.chars;

  return { paragraphs, charCount, view: "accepted" };
};

// ── Markdown extraction ─────────────────────────────────

const HEADING_LEVEL: Record<string, number> = {
  Heading1: 1,
  Heading2: 2,
  Heading3: 3,
  Heading4: 4,
  Heading5: 5,
  Heading6: 6,
  Title: 1,
  Subtitle: 2,
};

type RunFormat = {
  bold: boolean;
  italic: boolean;
};

/** Read run-level formatting from `w:rPr`. */
const readRunFormat = (run: slimdom.Element): RunFormat => {
  let bold = false;
  let italic = false;

  for (const child of run.childNodes) {
    if (!isElement(child) || child.localName !== "rPr") {
      continue;
    }
    for (const prop of child.childNodes) {
      if (!isElement(prop)) {
        continue;
      }
      if (prop.localName === "b" && prop.namespaceURI === W_NS) {
        const val = readAttr(prop, "val");
        bold = val !== "0" && val !== "false";
      }
      if (prop.localName === "i" && prop.namespaceURI === W_NS) {
        const val = readAttr(prop, "val");
        italic = val !== "0" && val !== "false";
      }
    }
    break;
  }

  return { bold, italic };
};

/** Collect formatted runs from a paragraph, applying Markdown inline markers. */
const collectFormattedText = (p: slimdom.Element): string => {
  const parts: string[] = [];

  const walkForText = (node: slimdom.Node) => {
    if (!isElement(node)) {
      return;
    }
    if (node.localName === "r" && node.namespaceURI === W_NS) {
      const runFmt = readRunFormat(node);
      for (const child of node.childNodes) {
        if (!isElement(child)) {
          continue;
        }
        if (child.localName === "t" && child.namespaceURI === W_NS) {
          let text = child.textContent ?? "";
          if (runFmt.bold && runFmt.italic) {
            text = `***${text}***`;
          } else if (runFmt.bold) {
            text = `**${text}**`;
          } else if (runFmt.italic) {
            text = `*${text}*`;
          }
          parts.push(text);
          continue;
        }
        if (child.localName === "br" && child.namespaceURI === W_NS) {
          parts.push("\n");
          continue;
        }
        if (child.localName === "tab" && child.namespaceURI === W_NS) {
          parts.push("\t");
        }
      }
      return;
    }
    // Skip deletions and moveFrom
    if (
      node.localName === "del" ||
      node.localName === "delText" ||
      node.localName === "moveFrom"
    ) {
      return;
    }
    for (const child of node.childNodes) {
      walkForText(child);
    }
  };

  walkForText(p);
  return parts.join("");
};

type ListInfo = {
  numId: number;
  ilvl: number;
};

type ListMarkerKind = "bullet" | "ordered";

type NumberingMetadata = Map<string, ListMarkerKind>;

const numberingKey = (numId: number, ilvl: number) => `${numId}-${ilvl}`;

/** Read OOXML numbering definitions so list markers do not depend on numId. */
const readNumberingMetadata = (
  numberingXml: string | null,
): NumberingMetadata => {
  const metadata: NumberingMetadata = new Map();

  if (numberingXml === null) {
    return metadata;
  }

  const numberingDoc = slimdom.parseXmlDocument(numberingXml);
  const abstractNumByNumId = new Map<number, number>();
  for (const num of numberingDoc.getElementsByTagNameNS(W_NS, "num")) {
    const numIdValue = readAttr(num, "numId");
    if (!numIdValue) {
      continue;
    }
    const numId = Number.parseInt(numIdValue, 10);
    if (!Number.isFinite(numId)) {
      continue;
    }
    for (const child of num.childNodes) {
      if (!isElement(child) || child.localName !== "abstractNumId") {
        continue;
      }
      const abstractNumIdValue = readAttr(child, "val");
      if (!abstractNumIdValue) {
        continue;
      }
      const abstractNumId = Number.parseInt(abstractNumIdValue, 10);
      if (Number.isFinite(abstractNumId)) {
        abstractNumByNumId.set(numId, abstractNumId);
      }
      break;
    }
  }

  const markerByAbstractLevel = new Map<string, ListMarkerKind>();
  for (const abstractNum of numberingDoc.getElementsByTagNameNS(
    W_NS,
    "abstractNum",
  )) {
    const abstractNumIdValue = readAttr(abstractNum, "abstractNumId");
    if (!abstractNumIdValue) {
      continue;
    }
    const abstractNumId = Number.parseInt(abstractNumIdValue, 10);
    if (!Number.isFinite(abstractNumId)) {
      continue;
    }
    for (const level of abstractNum.childNodes) {
      if (!isElement(level) || level.localName !== "lvl") {
        continue;
      }
      const ilvlValue = readAttr(level, "ilvl");
      if (!ilvlValue) {
        continue;
      }
      const ilvl = Number.parseInt(ilvlValue, 10);
      if (!Number.isFinite(ilvl)) {
        continue;
      }
      for (const child of level.childNodes) {
        if (!isElement(child) || child.localName !== "numFmt") {
          continue;
        }
        const numFmt = readAttr(child, "val");
        markerByAbstractLevel.set(
          `${abstractNumId}-${ilvl}`,
          numFmt === "bullet" ? "bullet" : "ordered",
        );
        break;
      }
    }
  }

  for (const [numId, abstractNumId] of abstractNumByNumId) {
    for (const [abstractLevelKey, marker] of markerByAbstractLevel) {
      const [levelAbstractNumId, ilvl] = abstractLevelKey.split("-");
      if (levelAbstractNumId !== String(abstractNumId) || ilvl === undefined) {
        continue;
      }
      metadata.set(numberingKey(numId, Number.parseInt(ilvl, 10)), marker);
    }
  }

  return metadata;
};

/** Read list numbering info from paragraph properties. */
const readListInfo = (p: slimdom.Element): ListInfo | null => {
  for (const child of p.childNodes) {
    if (!isElement(child) || child.localName !== "pPr") {
      continue;
    }
    for (const inner of child.childNodes) {
      if (!isElement(inner) || inner.localName !== "numPr") {
        continue;
      }
      let numId = 0;
      let ilvl = 0;
      for (const prop of inner.childNodes) {
        if (!isElement(prop)) {
          continue;
        }
        if (prop.localName === "numId") {
          const val = readAttr(prop, "val");
          if (val) {
            numId = Number.parseInt(val, 10) || 0;
          }
        }
        if (prop.localName === "ilvl") {
          const val = readAttr(prop, "val");
          if (val) {
            ilvl = Number.parseInt(val, 10) || 0;
          }
        }
      }
      if (numId > 0) {
        return { numId, ilvl };
      }
    }
    break;
  }
  return null;
};

/** Convert a single `w:p` element to a Markdown line. */
const paragraphToMarkdown = (
  p: slimdom.Element,
  listCounters: Map<string, number>,
  numbering: NumberingMetadata,
): string => {
  const text = collectFormattedText(p);
  if (!text.trim()) {
    return "";
  }

  const { style } = readParagraphProps(p);
  const headingLevel = style !== undefined ? HEADING_LEVEL[style] : undefined;
  if (headingLevel !== undefined) {
    return `${"#".repeat(headingLevel)} ${text.trim()}`;
  }

  const listInfo = readListInfo(p);
  if (listInfo) {
    const indent = "  ".repeat(listInfo.ilvl);
    const markerKind =
      numbering.get(numberingKey(listInfo.numId, listInfo.ilvl)) ?? "ordered";
    if (markerKind === "bullet") {
      return `${indent}- ${text.trim()}`;
    }
    const counterKey = `${listInfo.numId}-${listInfo.ilvl}`;
    const count = (listCounters.get(counterKey) ?? 0) + 1;
    listCounters.set(counterKey, count);
    return `${indent}${count}. ${text.trim()}`;
  }

  return text.trim();
};

/** Convert a `w:tbl` element to a Markdown table. */
const tableToMarkdown = (tbl: slimdom.Element): string => {
  const rows: string[][] = [];

  for (const trNode of tbl.childNodes) {
    if (!isElement(trNode) || trNode.localName !== "tr") {
      continue;
    }
    const cells: string[] = [];
    for (const tcNode of trNode.childNodes) {
      if (!isElement(tcNode) || tcNode.localName !== "tc") {
        continue;
      }
      // Collect all paragraph text in the cell
      const cellParts: string[] = [];
      for (const pNode of tcNode.childNodes) {
        if (!isElement(pNode) || pNode.localName !== "p") {
          continue;
        }
        const text = collectFormattedText(pNode).trim();
        if (text) {
          cellParts.push(text);
        }
      }
      cells.push(cellParts.join(" ").replaceAll("|", "\\|"));
    }
    rows.push(cells);
  }

  if (rows.length === 0) {
    return "";
  }

  const lines: string[] = [];
  const firstRow = rows[0];
  if (!firstRow || firstRow.length === 0) {
    return "";
  }

  // Header row
  lines.push(`| ${firstRow.join(" | ")} |`);
  lines.push(`| ${firstRow.map(() => "---").join(" | ")} |`);

  // Data rows
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row) {
      // Pad row to match header column count
      while (row.length < firstRow.length) {
        row.push("");
      }
      lines.push(`| ${row.join(" | ")} |`);
    }
  }

  return lines.join("\n");
};

/** Walk a container (w:body, w:hdr, w:ftr) and produce Markdown lines. */
const containerToMarkdown = (
  container: slimdom.Element,
  numbering: NumberingMetadata,
): string[] => {
  const lines: string[] = [];
  const listCounters = new Map<string, number>();

  for (const child of container.childNodes) {
    if (!isElement(child)) {
      continue;
    }

    if (child.localName === "p" && child.namespaceURI === W_NS) {
      const line = paragraphToMarkdown(child, listCounters, numbering);
      lines.push(line);
      continue;
    }

    if (child.localName === "tbl" && child.namespaceURI === W_NS) {
      const table = tableToMarkdown(child);
      if (table) {
        lines.push("", table, "");
      }
      continue;
    }
  }

  return lines;
};

/**
 * Extract structured Markdown from a DOCX buffer.
 *
 * Converts headings to `#`, bold to `**`, italic to `*`,
 * tables to Markdown tables, and lists to `- ` / `1. `.
 * Skips headers/footers (not useful for AI context).
 * Omits tracked deletions.
 */
export const extractMarkdown = async (
  docxBytes: Uint8Array,
): Promise<string> => {
  const archive = await loadDocxArchive(docxBytes);

  const xml = await archive.readEntryString("word/document.xml");
  if (xml === null) {
    return "";
  }

  const doc = slimdom.parseXmlDocument(xml);
  const numbering = readNumberingMetadata(
    await archive.readEntryString("word/numbering.xml"),
  );

  const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);
  if (!body) {
    return "";
  }

  const lines = containerToMarkdown(body, numbering);

  // Collapse multiple blank lines into one
  return lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
};
