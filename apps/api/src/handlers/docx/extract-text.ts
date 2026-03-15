/** Extract plain-text content from a DOCX for AI context. */

import JSZip from "jszip";
import * as slimdom from "slimdom";

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
  /^\s*\{\{(#if|#elseif|#else|#each|\/if|\/each)\s*(.*?)\}\}\s*$/;

const DIRECTIVE_KIND_MAP: Record<string, BlockDirectiveKind> = {
  "#if": "if",
  "#elseif": "elseif",
  "#else": "else",
  "#each": "each",
  "/if": "endif",
  "/each": "endeach",
};

/** Concatenate all `w:t` text, skipping `w:del`, `w:delText`, and `w:moveFrom`. */
const collectText = (el: slimdom.Element): string => {
  let text = "";
  const walk = (node: slimdom.Node) => {
    if (!isElement(node)) {
      return;
    }
    if (node.localName === "t" && node.namespaceURI === W_NS) {
      text += node.textContent ?? "";
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
  style?: string;
  alignment?: "left" | "center" | "right" | "both";
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

type RunMetrics = { bold: boolean; fontSize?: number; chars: number };

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

  for (const child of container.childNodes) {
    if (!isElement(child)) {
      continue;
    }
    if (child.localName !== "p" || child.namespaceURI !== W_NS) {
      continue;
    }

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

    const dm = text.match(DIRECTIVE_RE);
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
 * the ZIP, sorted by file name for deterministic ordering.
 */
const extractHeaderFooterParagraphs = async (
  zip: JSZip,
  source: ParagraphSource,
  rootTag: string,
  startIndex: number,
): Promise<{ paragraphs: ExtractedParagraph[]; chars: number }> => {
  const chunks: ExtractedParagraph[][] = [];
  let chars = 0;
  let index = startIndex;

  const prefix = `word/${source === "header" ? "header" : "footer"}`;
  const entries = Object.keys(zip.files)
    .filter((path) => HEADER_FOOTER_RE.test(path) && path.startsWith(prefix))
    .toSorted();

  for (const path of entries) {
    const entry = zip.file(path);
    if (!entry) {
      continue;
    }

    const xml = await entry.async("string");
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
  const zip = await JSZip.loadAsync(docxBytes);
  const emptyResult: ExtractedDocument = {
    paragraphs: [],
    charCount: 0,
    view: "accepted",
  };

  const docEntry = zip.file("word/document.xml");
  if (!docEntry) {
    return emptyResult;
  }

  const xml = await docEntry.async("string");
  const doc = slimdom.parseXmlDocument(xml);

  const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);
  if (!body) {
    return emptyResult;
  }

  // Extract headers (before body)
  const headers = await extractHeaderFooterParagraphs(zip, "header", "hdr", 0);

  // Extract body
  const bodyResult = extractParagraphsFromContainer(
    body,
    "body",
    headers.paragraphs.length,
  );

  // Extract footers (after body)
  const footers = await extractHeaderFooterParagraphs(
    zip,
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
