import { panic, Result, TaggedError } from "better-result";
import * as slimdom from "slimdom";

import type { FolioReviewChangeKind } from "@stll/folio-core/server";

import { loadDocxArchive } from "@/api/lib/docx-archive";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MAIN_PART = "word/document.xml";
const CONTENT_PART_RE = /^word\/(?:header|footer)\d+\.xml$/u;
const NOTE_PART_RE = /^word\/(?:footnotes|endnotes)\.xml$/u;
const MARKER_PREFIX = "stella-translation";

export const TRACKED_CHANGE_TAGS_BY_KIND = {
  insertion: ["ins", "moveTo", "moveToRangeStart", "moveToRangeEnd"],
  deletion: ["del", "moveFrom", "moveFromRangeStart", "moveFromRangeEnd"],
  formatting: ["rPrChange"],
  rowInserted: ["ins"],
  rowDeleted: ["del"],
  cellInserted: ["cellIns"],
  cellDeleted: ["cellDel"],
  cellMerged: ["cellMerge"],
  paragraphMarkInserted: ["ins"],
  paragraphMarkDeleted: ["del"],
  paragraphPropertiesChanged: ["pPrChange"],
  sectionPropertiesChanged: ["sectPrChange"],
  tablePropertiesChanged: ["tblPrChange"],
  tablePropertyExceptionsChanged: ["tblPrExChange"],
  rowPropertiesChanged: ["trPrChange"],
  cellPropertiesChanged: ["tcPrChange"],
} as const satisfies Record<FolioReviewChangeKind, readonly string[]>;

const TRACKED_CHANGE_TAGS = new Set(
  Object.values(TRACKED_CHANGE_TAGS_BY_KIND).flat(),
);

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
): Result<never, DocxTranslationError> =>
  Result.err(new DocxTranslationError({ message, reason, cause }));

const isElement = (node: slimdom.Node): node is slimdom.Element =>
  node.nodeType === node.ELEMENT_NODE;

const isWordElement = (
  node: slimdom.Node,
  localName: string,
): node is slimdom.Element =>
  isElement(node) && node.namespaceURI === W_NS && node.localName === localName;

const parseXml = (
  path: string,
  xml: string,
): Result<slimdom.Document, DocxTranslationError> =>
  Result.try({
    try: () => slimdom.parseXmlDocument(xml),
    catch: (error) =>
      new DocxTranslationError({
        message: `Malformed WordprocessingML in ${path}`,
        reason: "malformed-xml",
        cause: error,
      }),
  });

type TranslationArchive = Awaited<ReturnType<typeof loadDocxArchive>>;

const loadTranslationArchive = async (
  buffer: ArrayBuffer,
): Promise<Result<TranslationArchive, DocxTranslationError>> =>
  await Result.tryPromise({
    try: async () => await loadDocxArchive(buffer),
    catch: (error) =>
      new DocxTranslationError({
        message: "Failed to load DOCX translation input",
        reason: "archive",
        cause: error,
      }),
  });

const hasTrackedChanges = (doc: slimdom.Document): boolean => {
  for (const name of TRACKED_CHANGE_TAGS) {
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
  archive: TranslationArchive,
  paths: readonly string[],
  contentPaths: readonly string[],
): Promise<Result<Map<string, string>, DocxTranslationError>> => {
  const contentXml = new Map<string, string>();
  const contentPathSet = new Set(contentPaths);
  const inspected = await Promise.all(
    paths
      .filter((path) => path.endsWith(".xml"))
      .map(async (path) => ({
        path,
        xml: await archive.readEntryString(path),
      })),
  );
  for (const { path, xml } of inspected) {
    // Other XML parts are not translation inputs.
    if (xml === null || !contentPathSet.has(path)) {
      continue;
    }
    contentXml.set(path, xml);
    // A malformed content part is parsed again in `parsePart`, which reports
    // its exact path, so a parse failure here only skips the review check.
    const doc = Result.try(() => slimdom.parseXmlDocument(xml));
    if (doc.isOk() && hasTrackedChanges(doc.value)) {
      return fail(
        "unsupported-review-markup",
        "DOCX archive contains unresolved tracked changes",
      );
    }
  }
  return Result.ok(contentXml);
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
      // Both come from the same document: every w:t a paragraph walk finds is
      // one of the part's w:t elements the ordinals were numbered from.
      return panic(`DOCX part ${partPath} has an unmapped w:t node`);
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

const parsePart = (
  path: string,
  xml: string,
): Result<DocxTranslationSegment[], DocxTranslationError> => {
  const parsed = parseXml(path, xml);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const doc = parsed.value;
  if (hasTrackedChanges(doc)) {
    return fail(
      "unsupported-review-markup",
      `DOCX part ${path} contains unresolved tracked changes`,
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
  return Result.ok(segments);
};

/** Extract deterministic, marker-tagged WordprocessingML text for an LLM. */
export const extractDocxTranslationSegments = async (
  buffer: ArrayBuffer,
): Promise<Result<DocxTranslationDocument, DocxTranslationError>> =>
  await Result.gen(async function* () {
    const archive = yield* Result.await(loadTranslationArchive(buffer));
    if (!archive.zip.file(MAIN_PART)) {
      return fail(
        "missing-document",
        "DOCX archive is missing word/document.xml",
      );
    }

    const paths = contentPartPaths(Object.keys(archive.zip.files));
    const contentXml = yield* Result.await(
      inspectXmlParts(archive, Object.keys(archive.zip.files), paths),
    );

    const segments: DocxTranslationSegment[] = [];
    for (const path of paths) {
      const xml = contentXml.get(path);
      if (xml === undefined) {
        continue;
      }
      segments.push(...(yield* parsePart(path, xml)));
    }
    return Result.ok(Object.freeze({ segments: Object.freeze(segments) }));
  });

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
): Result<Map<string, string>, DocxTranslationError> => {
  const expected = segment.runs.map((run) => run.markerId);
  const matches = [...taggedText.matchAll(markerToken)];
  if (matches.length !== expected.length * 2) {
    return fail(
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
      // The loop stays within `expected`, whose ids are never empty.
      return panic(
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
      return fail(
        "invalid-markers",
        `Translation for ${segment.segmentId} has missing, duplicate, or reordered markers`,
      );
    }
    const start = (matches[cursor]?.index ?? 0) + expectedOpen.length;
    const end = matches[cursor + 1]?.index ?? 0;
    const value = taggedText.slice(start, end);
    if (value.match(markerToken) !== null) {
      return fail(
        "invalid-markers",
        `Translation for ${segment.segmentId} nests a marker`,
      );
    }
    result.set(markerId, value);
    cursor += 2;
    lastEnd = (matches[cursor - 1]?.index ?? 0) + expectedClose.length;
  }
  if (cursor !== matches.length || lastEnd !== taggedText.length) {
    return fail(
      "invalid-markers",
      `Translation for ${segment.segmentId} has extra markers`,
    );
  }
  return Result.ok(result);
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
): Result<string, DocxTranslationError> => {
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
    return fail(
      "malformed-xml",
      "DOCX translation markers did not map to the original w:t nodes",
    );
  }
  return Result.ok(patched);
};

/** Apply a complete, ordered set of model responses to the original DOCX. */
export const applyDocxTranslationSegments = async (
  buffer: ArrayBuffer,
  translations: readonly DocxTranslation[],
): Promise<Result<ArrayBuffer, DocxTranslationError>> =>
  await Result.gen(async function* () {
    const document = yield* Result.await(
      extractDocxTranslationSegments(buffer),
    );
    if (translations.length !== document.segments.length) {
      return fail(
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
      const byMarker = yield* replacementByMarker(
        segment,
        translation.taggedText,
      );
      const partReplacements =
        replacementByPart.get(segment.partPath) ?? new Map<number, string>();
      for (let runIndex = 0; runIndex < segment.runs.length; runIndex += 1) {
        const run = segment.runs.at(runIndex);
        if (!run) {
          // The loop stays within `segment.runs`.
          return panic(
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

    const archive = yield* Result.await(loadTranslationArchive(buffer));
    const patchedParts = await Promise.all(
      [...replacementByPart].map(async ([path, replacements]) => {
        const xml = await archive.readEntryString(path);
        if (xml === null) {
          return fail(
            "archive",
            `DOCX translation part ${path} disappeared during patching`,
          );
        }
        return patchTextNodes(xml, replacements).map((patched) => ({
          path,
          xml: patched,
        }));
      }),
    );
    for (const patchedPart of patchedParts) {
      const { path, xml } = yield* patchedPart;
      archive.zip.file(path, xml);
    }
    return Result.ok(await archive.zip.generateAsync({ type: "arraybuffer" }));
  });
