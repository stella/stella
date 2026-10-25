/**
 * The paragraphs a Word file states, read straight from its package.
 *
 * Written for retention projections, so it shares nothing with the document
 * reader the parsers use: it walks the WordprocessingML itself and keeps what
 * a reader of the file sees, which is every paragraph of the body (table
 * cells and text boxes included) and of the foot- and endnotes. Page headers
 * and footers live in parts of their own and are left out, as are tracked
 * deletions, field instructions, hidden runs and the fallback copy of
 * alternate content, none of which is visible text.
 */
import * as cheerio from "cheerio";
import { type AnyNode, isTag, isText } from "domhandler";

import { hexValue } from "@/api/handlers/case-law/ingestion/retention/sources/hex-value";

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const LOCAL_SIGNATURE = 0x04_03_4b_50;
/** The end record is 22 bytes plus a comment of at most 64 KiB. */
const EOCD_MAX_DISTANCE = 22 + 0xff_ff;
const STORED = 0;
const DEFLATED = 8;
/** A 32-bit size field holding this says the real size is in a ZIP64 record. */
const ZIP64_MARKER = 0xff_ff_ff_ff;

/**
 * Each entry's bytes by name, or `null` for a package this cannot open.
 * Only the parts asked for are inflated.
 */
const readZipEntries = (
  bytes: Uint8Array,
  wanted: ReadonlySet<string>,
): Map<string, Uint8Array> | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - EOCD_MAX_DISTANCE);
  let eocd = -1;
  for (let at = bytes.length - 22; at >= lowest; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) {
    return null;
  }
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const entries = new Map<string, Uint8Array>();
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > bytes.length ||
      view.getUint32(cursor, true) !== CENTRAL_SIGNATURE
    ) {
      return null;
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = names.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!wanted.has(name)) {
      continue;
    }
    if (
      compressedSize === ZIP64_MARKER ||
      localOffset + 30 > bytes.length ||
      view.getUint32(localOffset, true) !== LOCAL_SIGNATURE
    ) {
      return null;
    }
    const dataStart =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    // A copy, which owns a plain ArrayBuffer as the inflater requires.
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    if (method === STORED) {
      entries.set(name, data);
    } else if (method === DEFLATED) {
      entries.set(name, Bun.inflateSync(data));
    } else {
      return null;
    }
  }
  return entries;
};

/** Local name of an element, without its namespace prefix. */
const localName = (node: AnyNode): string | undefined =>
  isTag(node) ? (node.name.split(":").at(-1) ?? node.name) : undefined;

const attribute = (node: AnyNode, name: string): string | undefined =>
  isTag(node) ? node.attribs[`w:${name}`] : undefined;

/** Run properties that switch a toggle off say so with one of these. */
const OFF_VALUES = new Set(["0", "false", "off"]);

/** Whether a run carries the `vanish` property, which hides it on the page. */
const isHiddenRun = (run: AnyNode): boolean => {
  if (!isTag(run)) {
    return false;
  }
  const properties = run.children.find((child) => localName(child) === "rPr");
  if (properties === undefined || !isTag(properties)) {
    return false;
  }
  return properties.children.some(
    (child) =>
      localName(child) === "vanish" &&
      !OFF_VALUES.has(attribute(child, "val") ?? ""),
  );
};

/** Subtrees that hold no visible text: tracked deletions, field codes, a fallback copy. */
const SKIPPED = new Set([
  "del",
  "delText",
  "instrText",
  "rPr",
  "pPr",
  "Fallback",
]);

/**
 * Every paragraph under `root`, in document order. A paragraph nested in
 * another one (a text box anchored in it) is its own entry, so neither
 * paragraph's text is counted inside the other.
 */
const paragraphsOf = (roots: readonly AnyNode[]): string[] => {
  const paragraphs: string[] = [];
  const walk = (node: AnyNode, into: string[]): void => {
    const name = localName(node);
    if (name === undefined) {
      return;
    }
    if (SKIPPED.has(name) || (name === "r" && isHiddenRun(node))) {
      return;
    }
    switch (name) {
      case "p": {
        const own: string[] = [];
        // Reserve this paragraph's slot before its nested ones are added,
        // so the list stays in reading order.
        const slot = paragraphs.length;
        paragraphs.push("");
        for (const child of isTag(node) ? node.children : []) {
          walk(child, own);
        }
        paragraphs[slot] = own.join("");
        return;
      }
      case "t":
        for (const child of isTag(node) ? node.children : []) {
          if (isText(child)) {
            into.push(child.data);
          }
        }
        return;
      case "tab":
      case "ptab":
        into.push("\t");
        return;
      case "br":
      case "cr":
        into.push("\n");
        return;
      case "noBreakHyphen":
        into.push("‑");
        return;
      case "sym": {
        // Hex, at most five digits, so always within Unicode's range.
        const code = hexValue(attribute(node, "char") ?? "", 5);
        if (code !== undefined) {
          into.push(String.fromCodePoint(code));
        }
        return;
      }
      default:
        for (const child of isTag(node) ? node.children : []) {
          walk(child, into);
        }
    }
  };
  for (const root of roots) {
    walk(root, []);
  }
  return paragraphs;
};

const DOCUMENT_PART = "word/document.xml";
const NOTE_PARTS = ["word/footnotes.xml", "word/endnotes.xml"] as const;

/**
 * The paragraphs of a Word package, or `null` for bytes that are not one:
 * no central directory, an entry it cannot inflate, or no document part.
 */
export const docxParagraphs = (bytes: Uint8Array): string[] | null => {
  const entries = readZipEntries(
    bytes,
    new Set([DOCUMENT_PART, ...NOTE_PARTS]),
  );
  const document = entries?.get(DOCUMENT_PART);
  if (entries === null || document === undefined) {
    return null;
  }
  const decoder = new TextDecoder();
  return [document, ...NOTE_PARTS.map((part) => entries.get(part))].flatMap(
    (part) => {
      if (part === undefined) {
        return [];
      }
      const $ = cheerio.load(decoder.decode(part), { xml: true });
      return paragraphsOf($.root().children().toArray());
    },
  );
};
