/**
 * Extract DOCX text with tracked-change annotations for chat
 * context. Produces three views: simple (accepted), original
 * (changes rejected), and tracked-changes (inline redline).
 *
 * The existing `extractText` in extract-text.ts is left
 * unchanged; it serves search indexing. This module serves
 * the chat file-attachment flow.
 */

import JSZip from "jszip";
import * as slimdom from "slimdom";

import { HEADER_FOOTER_RE, isElement, W_NS } from "./ooxml";
import type { ChatExtractedDocument } from "./types";

// ── Attribute helpers ────────────────────────────────────

const readAttr = (el: slimdom.Element, local: string): string | undefined =>
  el.getAttributeNS(W_NS, local) ?? el.getAttribute(`w:${local}`) ?? undefined;

/** Format a date string for display. Uses just the date
 *  portion of an ISO datetime, or falls back to raw. */
const formatDate = (raw: string | undefined): string => {
  if (!raw) {
    return "unknown date";
  }
  // ISO dates from Word: "2026-03-01T14:30:00Z"
  const dateOnly = raw.slice(0, 10);
  return dateOnly || raw;
};

// ── Text collectors ──────────────────────────────────────

/**
 * Collect accepted text: includes `w:t`, skips `w:del`,
 * `w:delText`, `w:moveFrom`. Same logic as the existing
 * `collectText` in extract-text.ts.
 */
const collectSimpleText = (el: slimdom.Element): string => {
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

/**
 * Collect original text: includes `w:delText` and skips
 * inserted text (text inside `w:ins` elements).
 */
const collectOriginalText = (el: slimdom.Element): string => {
  let text = "";
  const walk = (node: slimdom.Node, insideIns: boolean) => {
    if (!isElement(node)) {
      return;
    }
    const { localName, namespaceURI } = node;

    if (localName === "ins" && namespaceURI === W_NS) {
      // Skip inserted content entirely
      return;
    }
    if (localName === "moveTo" && namespaceURI === W_NS) {
      // moveTo is treated as insert; skip
      return;
    }
    if (localName === "t" && namespaceURI === W_NS && !insideIns) {
      text += node.textContent ?? "";
    } else if (localName === "delText" && namespaceURI === W_NS) {
      text += node.textContent ?? "";
    } else if (localName === "moveFrom" && namespaceURI === W_NS) {
      // moveFrom contains the original text at its source
      // location; walk children outside any insert context.
      for (const c of node.childNodes) {
        walk(c, false);
      }
    } else {
      for (const c of node.childNodes) {
        walk(c, insideIns);
      }
    }
  };
  walk(el, false);
  return text;
};

/**
 * Collect text with inline tracked-change annotations.
 * Insertions: [INS by Author, Date: "text"]
 * Deletions: [DEL by Author, Date: "text"]
 */
const collectTrackedChangesText = (el: slimdom.Element): string => {
  let text = "";

  const collectAllText = (
    node: slimdom.Node,
    tagName: "t" | "delText",
  ): string => {
    let result = "";
    if (!isElement(node)) {
      return result;
    }
    if (node.localName === tagName && node.namespaceURI === W_NS) {
      result += node.textContent ?? "";
    } else {
      for (const c of node.childNodes) {
        result += collectAllText(c, tagName);
      }
    }
    return result;
  };

  const walk = (node: slimdom.Node) => {
    if (!isElement(node)) {
      return;
    }
    const { localName, namespaceURI } = node;

    if (localName === "ins" && namespaceURI === W_NS) {
      const author = readAttr(node, "author") ?? "Unknown";
      const date = formatDate(readAttr(node, "date"));
      const insText = collectAllText(node, "t");
      if (insText) {
        text += `[INS by ${author}, ${date}: "${insText}"]`;
      }
      return;
    }

    if (localName === "del" && namespaceURI === W_NS) {
      const author = readAttr(node, "author") ?? "Unknown";
      const date = formatDate(readAttr(node, "date"));
      const delText = collectAllText(node, "delText");
      if (delText) {
        text += `[DEL by ${author}, ${date}: "${delText}"]`;
      }
      return;
    }

    if (localName === "moveFrom" && namespaceURI === W_NS) {
      const author = readAttr(node, "author") ?? "Unknown";
      const date = formatDate(readAttr(node, "date"));
      const fromText =
        collectAllText(node, "t") || collectAllText(node, "delText");
      if (fromText) {
        text += `[DEL by ${author}, ${date}: "${fromText}"]`;
      }
      return;
    }

    if (localName === "moveTo" && namespaceURI === W_NS) {
      const author = readAttr(node, "author") ?? "Unknown";
      const date = formatDate(readAttr(node, "date"));
      const toText = collectAllText(node, "t");
      if (toText) {
        text += `[INS by ${author}, ${date}: "${toText}"]`;
      }
      return;
    }

    if (localName === "t" && namespaceURI === W_NS) {
      text += node.textContent ?? "";
    } else if (localName !== "delText" || namespaceURI !== W_NS) {
      for (const c of node.childNodes) {
        walk(c);
      }
    }
  };

  walk(el);
  return text;
};

// ── Container extraction ─────────────────────────────────

type ThreeViews = {
  simple: string[];
  original: string[];
  trackedChanges: string[];
};

const extractParagraphsFromContainer = (
  container: slimdom.Element,
): ThreeViews => {
  const views: ThreeViews = {
    simple: [],
    original: [],
    trackedChanges: [],
  };

  for (const child of container.childNodes) {
    if (!isElement(child)) {
      continue;
    }
    if (child.localName !== "p" || child.namespaceURI !== W_NS) {
      continue;
    }
    views.simple.push(collectSimpleText(child));
    views.original.push(collectOriginalText(child));
    views.trackedChanges.push(collectTrackedChangesText(child));
  }

  return views;
};

const mergeViews = (target: ThreeViews, source: ThreeViews) => {
  target.simple.push(...source.simple);
  target.original.push(...source.original);
  target.trackedChanges.push(...source.trackedChanges);
};

const extractHeaderFooterViews = async (
  zip: JSZip,
  prefix: string,
  rootTag: string,
): Promise<ThreeViews> => {
  const views: ThreeViews = {
    simple: [],
    original: [],
    trackedChanges: [],
  };

  const entries = Object.keys(zip.files)
    .filter((path) => HEADER_FOOTER_RE.test(path) && path.startsWith(prefix))
    .sort();

  for (const path of entries) {
    const entry = zip.file(path);
    if (!entry) {
      continue;
    }

    const xml = await entry.async("string");
    const doc = slimdom.parseXmlDocument(xml);
    const container = doc.getElementsByTagNameNS(W_NS, rootTag)[0];

    if (!container) {
      continue;
    }

    mergeViews(views, extractParagraphsFromContainer(container));
  }

  return views;
};

// ── Public API ───────────────────────────────────────────

/**
 * Extract DOCX text in three revision views for chat context.
 * Does not produce paragraph metadata (styles, bold, etc.)
 * since that is only needed for template processing.
 */
export const extractTextForChat = async (
  docxBytes: Uint8Array,
): Promise<ChatExtractedDocument> => {
  const empty: ChatExtractedDocument = {
    simple: "",
    original: "",
    trackedChanges: "",
  };

  const zip = await JSZip.loadAsync(docxBytes);
  const docEntry = zip.file("word/document.xml");
  if (!docEntry) {
    return empty;
  }

  const xml = await docEntry.async("string");
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) {
    return empty;
  }

  const headers = await extractHeaderFooterViews(zip, "word/header", "hdr");
  const bodyViews = extractParagraphsFromContainer(body);
  const footers = await extractHeaderFooterViews(zip, "word/footer", "ftr");

  const join = (parts: string[]): string => parts.filter(Boolean).join("\n");

  return {
    simple: join([...headers.simple, ...bodyViews.simple, ...footers.simple]),
    original: join([
      ...headers.original,
      ...bodyViews.original,
      ...footers.original,
    ]),
    trackedChanges: join([
      ...headers.trackedChanges,
      ...bodyViews.trackedChanges,
      ...footers.trackedChanges,
    ]),
  };
};
