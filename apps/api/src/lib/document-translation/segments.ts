import { TaggedError } from "better-result";
import * as slimdom from "slimdom";

import { loadDocxArchive } from "@/api/lib/docx-archive";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MAIN_PART = "word/document.xml";
const CONTENT_PART_RE = /^word\/(?:header|footer)\d+\.xml$/u;
const NOTE_PART_RE = /^word\/(?:footnotes|endnotes)\.xml$/u;
const COMMENT_PART_RE = /^word\/comments[^/]*\.xml$/u;
const MARKER_PREFIX = "stella-translation";
type DocxTranslationErrorReason =
  | "archive"
  | "missing-document"
  | "malformed-xml"
  | "unsupported-review-markup"
  | "invalid-markers";

export type DocxTranslationTextRun = Readonly<{
  markerId: string;
  text: string;
  /** Position among all w:t nodes in the source part; used only for patching. */
  textNodeOrdinal: number;
}>;

export type DocxTranslationSegment = Readonly<{
  segmentId: string;
  partPath: string;
  paragraphIndex: number;
  text: string;
  taggedText: string;
  runs: readonly DocxTranslationTextRun[];
}>;

export type DocxTranslation = Readonly<{
  segmentId: string;
  taggedText: string;
}>;

export type DocxTranslationDocument = Readonly<{
  segments: readonly DocxTranslationSegment[];
}>;

export class DocxTranslationError extends TaggedError("DocxTranslationError")<{
  message: string;
  reason: DocxTranslationErrorReason;
  cause?: unknown;
}> {}

const fail = (
  reason: DocxTranslationErrorReason,
  message: string,
  cause?: unknown,
): never => {
  throw new DocxTranslationError({ message, reason, cause });
};

const isElement = (node: slimdom.Node): node is slimdom.Element =>
  node.nodeType === node.ELEMENT_NODE;

const isWordElement = (
  node: slimdom.Node,
  localName: string,
): node is slimdom.Element =>
  isElement(node) && node.namespaceURI === W_NS && node.localName === localName;

const parseXml = (path: string, xml: string): slimdom.Document => {
  try {
    return slimdom.parseXmlDocument(xml);
  } catch (error) {
    return fail(
      "malformed-xml",
      `Malformed WordprocessingML in ${path}`,
      error,
    );
  }
};

const loadTranslationArchive = async (buffer: ArrayBuffer) => {
  try {
    return await loadDocxArchive(buffer);
  } catch (error) {
    return fail("archive", "Failed to load DOCX translation input", error);
  }
};

const hasReviewMarkup = (doc: slimdom.Document): boolean => {
  for (const name of [
    "ins",
    "del",
    "moveFrom",
    "moveTo",
    "moveFromRangeStart",
    "moveFromRangeEnd",
    "moveToRangeStart",
    "moveToRangeEnd",
    "commentRangeStart",
    "commentRangeEnd",
    "commentReference",
    "comment",
  ]) {
    if (doc.getElementsByTagNameNS(W_NS, name).length > 0) {
      return true;
    }
  }
  return false;
};

const contentPartPaths = (paths: readonly string[]): string[] =>
  paths
    .filter(
      (path) =>
        path === MAIN_PART ||
        CONTENT_PART_RE.test(path) ||
        NOTE_PART_RE.test(path),
    )
    .toSorted();

const inspectXmlParts = async (
  archive: Awaited<ReturnType<typeof loadDocxArchive>>,
  paths: readonly string[],
  contentPaths: readonly string[],
): Promise<Map<string, string>> => {
  const contentXml = new Map<string, string>();
  const contentPathSet = new Set(contentPaths);
  const inspected = await Promise.all(
    paths
      .filter((path) => path.endsWith(".xml"))
      .map(async (path) => {
        if (COMMENT_PART_RE.test(path)) {
          return fail(
            "unsupported-review-markup",
            "DOCX archive contains tracked changes or comments",
          );
        }
        return { path, xml: await archive.readEntryString(path) };
      }),
  );
  for (const { path, xml } of inspected) {
    if (xml === null) {
      continue;
    }
    if (contentPathSet.has(path)) {
      contentXml.set(path, xml);
    }
    let doc: slimdom.Document | null = null;
    try {
      doc = slimdom.parseXmlDocument(xml);
    } catch {
      // Required content parts are parsed again below so they can report the
      // exact malformed path. Other XML parts are not translation inputs.
    }
    if (doc !== null && hasReviewMarkup(doc)) {
      return fail(
        "unsupported-review-markup",
        "DOCX archive contains tracked changes or comments",
      );
    }
  }
  return contentXml;
};

const paragraphRuns = (paragraph: slimdom.Element): slimdom.Element[] => {
  const result: slimdom.Element[] = [];
  const walk = (node: slimdom.Node) => {
    if (node !== paragraph && isWordElement(node, "p")) {
      return;
    }
    if (
      isElement(node) &&
      (node.localName === "instrText" || node.localName === "delText")
    ) {
      return;
    }
    if (isWordElement(node, "t")) {
      result.push(node);
      return;
    }
    for (const child of node.childNodes) {
      walk(child);
    }
  };
  walk(paragraph);
  return result;
};

const markerOpen = (markerId: string): string =>
  `[[${MARKER_PREFIX}:${markerId}]]`;
const markerClose = (markerId: string): string =>
  `[[/${MARKER_PREFIX}:${markerId}]]`;

const markerIdFor = (segmentId: string, runIndex: number): string =>
  `${segmentId}:t${String(runIndex + 1).padStart(6, "0")}`;

const freezeRun = (run: DocxTranslationTextRun): DocxTranslationTextRun =>
  Object.freeze(run);

const freezeSegment = (
  segment: DocxTranslationSegment,
): DocxTranslationSegment =>
  Object.freeze({
    ...segment,
    runs: Object.freeze(segment.runs.map(freezeRun)),
  });

const makeSegment = (
  partPath: string,
  paragraphIndex: number,
  paragraph: slimdom.Element,
  textNodeOrdinals: ReadonlyMap<slimdom.Element, number>,
): DocxTranslationSegment | null => {
  const textNodes = paragraphRuns(paragraph);
  if (textNodes.length === 0) {
    return null;
  }

  const segmentId = `${partPath}:p${String(paragraphIndex).padStart(6, "0")}`;
  const runs = textNodes.map((node, runIndex) => {
    const textNodeOrdinal = textNodeOrdinals.get(node);
    if (textNodeOrdinal === undefined) {
      return fail(
        "malformed-xml",
        `DOCX part ${partPath} has an unmapped w:t node`,
      );
    }
    return {
      markerId: markerIdFor(segmentId, runIndex),
      text: node.textContent ?? "",
      textNodeOrdinal,
    };
  });
  const taggedText = runs
    .map(
      ({ markerId, text }) =>
        `${markerOpen(markerId)}${text}${markerClose(markerId)}`,
    )
    .join("");
  return freezeSegment({
    segmentId,
    partPath,
    paragraphIndex,
    text: runs.map((run) => run.text).join(""),
    taggedText,
    runs,
  });
};

const parsePart = (path: string, xml: string): DocxTranslationSegment[] => {
  const doc = parseXml(path, xml);
  if (hasReviewMarkup(doc)) {
    fail(
      "unsupported-review-markup",
      `DOCX part ${path} contains tracked changes or comments`,
    );
  }
  const segments: DocxTranslationSegment[] = [];
  const textNodeOrdinals = new Map<slimdom.Element, number>();
  for (const [ordinal, textNode] of [
    ...doc.getElementsByTagNameNS(W_NS, "t"),
  ].entries()) {
    textNodeOrdinals.set(textNode, ordinal);
  }
  const paragraphs = doc.getElementsByTagNameNS(W_NS, "p");
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    if (!paragraph) {
      continue;
    }
    const segment = makeSegment(path, index + 1, paragraph, textNodeOrdinals);
    if (segment) {
      segments.push(segment);
    }
  }
  return segments;
};

/** Extract deterministic, marker-tagged WordprocessingML text for an LLM. */
export const extractDocxTranslationSegments = async (
  buffer: ArrayBuffer,
): Promise<DocxTranslationDocument> => {
  const archive = await loadTranslationArchive(buffer);
  if (!archive.zip.file(MAIN_PART)) {
    fail("missing-document", "DOCX archive is missing word/document.xml");
  }

  const paths = contentPartPaths(Object.keys(archive.zip.files));
  const contentXml = await inspectXmlParts(
    archive,
    Object.keys(archive.zip.files),
    paths,
  );

  const segments: DocxTranslationSegment[] = [];
  for (const path of paths) {
    const xml = contentXml.get(path);
    if (xml === undefined) {
      continue;
    }
    segments.push(...parsePart(path, xml));
  }
  return Object.freeze({ segments: Object.freeze(segments) });
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const markerToken = /\[\[\/?stella-translation:[^\]]+\]\]/gu;

const replacementByMarker = (
  segment: DocxTranslationSegment,
  taggedText: string,
): Map<string, string> => {
  const expected = segment.runs.map((run) => run.markerId);
  const matches = [...taggedText.matchAll(markerToken)];
  if (matches.length !== expected.length * 2) {
    fail(
      "invalid-markers",
      `Translation for ${segment.segmentId} must contain every marker exactly once`,
    );
  }
  const result = new Map<string, string>();
  let cursor = 0;
  let lastEnd = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const markerId = expected.at(index);
    if (!markerId) {
      return fail(
        "invalid-markers",
        `Translation for ${segment.segmentId} has an invalid marker index`,
      );
    }
    const expectedOpen = markerOpen(markerId);
    const expectedClose = markerClose(markerId);
    const open = matches[cursor]?.[0];
    const close = matches[cursor + 1]?.[0];
    if (
      open !== expectedOpen ||
      close !== expectedClose ||
      matches[cursor]?.index !== lastEnd
    ) {
      fail(
        "invalid-markers",
        `Translation for ${segment.segmentId} has missing, duplicate, or reordered markers`,
      );
    }
    const start = (matches[cursor]?.index ?? 0) + expectedOpen.length;
    const end = matches[cursor + 1]?.index ?? 0;
    const value = taggedText.slice(start, end);
    if (value.match(markerToken) !== null) {
      fail(
        "invalid-markers",
        `Translation for ${segment.segmentId} nests a marker`,
      );
    }
    result.set(markerId, value);
    cursor += 2;
    lastEnd = (matches[cursor - 1]?.index ?? 0) + expectedClose.length;
  }
  if (cursor !== matches.length || lastEnd !== taggedText.length) {
    fail(
      "invalid-markers",
      `Translation for ${segment.segmentId} has extra markers`,
    );
  }
  return result;
};

const wordTextElementName = (xml: string): string => {
  const prefixed =
    /xmlns:(?<prefix>[A-Za-z_][\w.-]*)\s*=\s*["']http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main["']/u.exec(
      xml,
    )?.groups?.["prefix"];
  if (prefixed) {
    return `${prefixed}:t`;
  }
  if (
    /xmlns\s*=\s*["']http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main["']/u.test(
      xml,
    )
  ) {
    return "t";
  }
  return "w:t";
};

const patchTextNodes = (
  xml: string,
  replacements: ReadonlyMap<number, string>,
): string => {
  const elementName = wordTextElementName(xml).replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  const closingElementName = wordTextElementName(xml);
  const textElement = new RegExp(
    `<${elementName}\\b[^>]*?(?:>(?<content>[\\s\\S]*?)<\\/${elementName}>|\\s*/>)`,
    "gu",
  );
  let ordinal = 0;
  const applied = new Set<number>();
  const patched = xml.replace(textElement, (whole, ...args: unknown[]) => {
    const groups = args.at(-1);
    const groupsObject =
      typeof groups === "object" && groups !== null && "content" in groups
        ? groups
        : undefined;
    const content =
      groupsObject !== undefined && typeof groupsObject.content === "string"
        ? groupsObject.content
        : "";
    const currentOrdinal = ordinal;
    const replacement = replacements.get(currentOrdinal);
    ordinal += 1;
    if (replacement === undefined) {
      return whole;
    }
    applied.add(currentOrdinal);
    if (content === "" && whole.trimEnd().endsWith("/>")) {
      if (replacement === "") {
        return whole;
      }
      const close = `</${closingElementName}>`;
      return `${whole.slice(0, whole.lastIndexOf("/"))}>${escapeXml(replacement)}${close}`;
    }
    const start = whole.indexOf(">") + 1;
    const end = whole.lastIndexOf("<");
    return `${whole.slice(0, start)}${escapeXml(replacement)}${whole.slice(end)}`;
  });
  if ([...replacements.keys()].some((key) => !applied.has(key))) {
    fail(
      "malformed-xml",
      "DOCX translation markers did not map to the original w:t nodes",
    );
  }
  return patched;
};

/** Apply a complete, ordered set of model responses to the original DOCX. */
export const applyDocxTranslationSegments = async (
  buffer: ArrayBuffer,
  translations: readonly DocxTranslation[],
): Promise<ArrayBuffer> => {
  const document = await extractDocxTranslationSegments(buffer);
  if (translations.length !== document.segments.length) {
    fail(
      "invalid-markers",
      `Expected ${document.segments.length} translation segments, received ${translations.length}`,
    );
  }

  const replacementByPart = new Map<string, Map<number, string>>();
  for (const [index, segment] of document.segments.entries()) {
    const translation = translations.at(index);
    if (!translation || translation.segmentId !== segment.segmentId) {
      return fail(
        "invalid-markers",
        `Translation segment ${index + 1} is missing, duplicated, or out of order`,
      );
    }
    const byMarker = replacementByMarker(segment, translation.taggedText);
    const partReplacements =
      replacementByPart.get(segment.partPath) ?? new Map<number, string>();
    for (let runIndex = 0; runIndex < segment.runs.length; runIndex += 1) {
      const run = segment.runs.at(runIndex);
      if (!run) {
        return fail(
          "invalid-markers",
          `Translation for ${segment.segmentId} has an invalid run index`,
        );
      }
      partReplacements.set(
        run.textNodeOrdinal,
        byMarker.get(run.markerId) ?? "",
      );
    }
    replacementByPart.set(segment.partPath, partReplacements);
  }

  const archive = await loadTranslationArchive(buffer);
  const patchedParts = await Promise.all(
    [...replacementByPart].map(async ([path, replacements]) => {
      const xml = await archive.readEntryString(path);
      if (xml === null) {
        return fail(
          "archive",
          `DOCX translation part ${path} disappeared during patching`,
        );
      }
      return { path, xml: patchTextNodes(xml, replacements) };
    }),
  );
  for (const { path, xml } of patchedParts) {
    archive.zip.file(path, xml);
  }
  return await archive.zip.generateAsync({ type: "arraybuffer" });
};
