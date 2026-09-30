import { Result } from "better-result";
import * as slimdom from "slimdom";

import { OOXML_NS } from "@stll/docx-utils";

import {
  DocxArchiveError,
  loadDocxArchive,
  type DocxArchive,
} from "@/api/lib/docx-archive";

import {
  TEXT_ORACLE_LIMITS,
  TextOracleError,
  type TextBaseline,
} from "./types";

const WORD_NAMESPACES = new Set([
  OOXML_NS.w,
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const TEXT_NAMESPACES = new Set([
  ...WORD_NAMESPACES,
  OOXML_NS.a,
  "http://purl.oclc.org/ooxml/drawingml/main",
  OOXML_NS.m,
  "http://purl.oclc.org/ooxml/officeDocument/math",
]);
const SKIPPED_WORD_ELEMENTS = new Set(["del", "moveFrom", "instrText"]);
const UNSUPPORTED_WORD_ELEMENTS = new Set([
  "altChunk",
  "subDoc",
  "sym",
  "footnoteReference",
  "endnoteReference",
  "footnoteRef",
  "endnoteRef",
  "vanish",
  "specVanish",
]);
const STORY_RELATIONSHIP_TYPES = new Set([
  "officeDocument",
  "header",
  "footer",
  "footnotes",
  "endnotes",
  "aFChunk",
  "subDocument",
]);
const STORY_PART_PATTERN =
  /^word\/(?:document|footnotes|endnotes|header[^/]*|footer[^/]*)\.xml$/u;

const archiveError = (cause: unknown) =>
  new TextOracleError({
    message: "Cannot read bounded DOCX archive",
    reason:
      cause instanceof DocxArchiveError && cause.reason !== "load-failed"
        ? "resource_limit"
        : "malformed",
    cause,
  });

const readPart = async (
  archive: DocxArchive,
  path: string,
): Promise<Result<string, TextOracleError>> => {
  const bytes = await Result.tryPromise({
    try: () => archive.readEntryUint8(path),
    catch: archiveError,
  });
  if (bytes.isErr()) {
    return bytes;
  }
  const entryBytes = bytes.value;
  if (!entryBytes) {
    return Result.err(
      new TextOracleError({
        message: "DOCX part is missing",
        reason: "malformed",
      }),
    );
  }
  return Result.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(entryBytes),
    catch: (cause) =>
      new TextOracleError({
        message: "DOCX XML encoding is unsupported or malformed",
        reason: "unsupported",
        cause,
      }),
  });
};

/** Bound element allocation before the XML parser constructs a DOM. */
const parsePartXml = (
  xml: string,
  previousNodes: number,
): Result<slimdom.Element, TextOracleError> => {
  const encoding = /<\?xml[^>]*encoding=["']([^"']+)["']/iu.exec(xml)?.at(1);
  if (encoding && !/^utf-?8$/iu.test(encoding)) {
    return Result.err(
      new TextOracleError({
        message: "DOCX declared XML encoding is unsupported",
        reason: "unsupported",
      }),
    );
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    return Result.err(
      new TextOracleError({
        message: "DOCX XML declarations are unsupported",
        reason: "unsupported",
      }),
    );
  }
  let tags = 0;
  let lexicalDepth = 0;
  for (const match of xml.matchAll(/<[^>]*>/gu)) {
    tags += 1;
    const tag = match[0];
    if (tag.startsWith("</")) {
      lexicalDepth -= 1;
    } else if (
      !tag.startsWith("<!") &&
      !tag.startsWith("<?") &&
      !tag.endsWith("/>")
    ) {
      lexicalDepth += 1;
    }
    if (
      tags + previousNodes > TEXT_ORACLE_LIMITS.nodes ||
      lexicalDepth > TEXT_ORACLE_LIMITS.depth
    ) {
      return Result.err(
        new TextOracleError({
          message: "DOCX XML node limit exceeded",
          reason: "resource_limit",
        }),
      );
    }
  }
  const parsed = Result.try({
    try: () => slimdom.parseXmlDocument(xml),
    catch: (cause) =>
      new TextOracleError({
        message: "Malformed DOCX XML",
        reason: "malformed",
        cause,
      }),
  });
  if (parsed.isErr()) {
    return parsed;
  }
  const root = parsed.value.documentElement;
  if (!root) {
    return Result.err(
      new TextOracleError({
        message: "DOCX XML root is missing",
        reason: "malformed",
      }),
    );
  }
  return Result.ok(root);
};

type StoryRelationOptions = {
  relation: slimdom.Element;
  relationshipPartPath: string;
  archive: DocxArchive;
};
const validateStoryRelation = ({
  relation,
  relationshipPartPath,
  archive,
}: StoryRelationOptions): Result<void, TextOracleError> => {
  if (relation.localName !== "Relationship" || relation.children.length !== 0) {
    return Result.err(
      new TextOracleError({
        message: "Unsupported DOCX relationship shape",
        reason: "unsupported",
      }),
    );
  }
  const type = relation.getAttribute("Type")?.split("/").at(-1);
  const target = relation.getAttribute("Target");
  if (
    type === "styles" &&
    (relation.getAttribute("TargetMode") === "External" ||
      (target !== "styles.xml" && target !== "/word/styles.xml"))
  ) {
    return Result.err(
      new TextOracleError({
        message: "DOCX nonconventional styles are unsupported",
        reason: "unsupported",
      }),
    );
  }
  if (!STORY_RELATIONSHIP_TYPES.has(type ?? "")) {
    return Result.ok();
  }
  const canonical =
    type === "officeDocument"
      ? target === "word/document.xml" || target === "/word/document.xml"
      : relationshipPartPath === "word/_rels/document.xml.rels" &&
        /^(?:\/word\/)?(?:footnotes|endnotes|header[^/]*|footer[^/]*)\.xml$/u.test(
          target ?? "",
        );
  if (!canonical || relation.getAttribute("TargetMode") === "External") {
    return Result.err(
      new TextOracleError({
        message: "DOCX has a nonconventional or external story relationship",
        reason: "unsupported",
      }),
    );
  }
  let partPath = target;
  if (target?.startsWith("/")) {
    partPath = target.slice(1);
  } else if (type !== "officeDocument") {
    partPath = `word/${target}`;
  }
  if (!partPath || !archive.zip.file(partPath)) {
    return Result.err(
      new TextOracleError({
        message: "DOCX story relationship target is missing",
        reason: "malformed",
      }),
    );
  }
  return Result.ok();
};

/** Nonconventional story locations require a relationship-aware baseline; never ignore them. */
const validateStoryLayout = async (
  archive: DocxArchive,
): Promise<Result<void, TextOracleError>> => {
  for (const file of archive.zip.file(/^(?:_rels\/\.rels|word\/.*\.rels)$/u)) {
    const xml = await readPart(archive, file.name);
    if (xml.isErr()) {
      return xml;
    }
    const parsed = parsePartXml(xml.value, 0);
    if (parsed.isErr()) {
      return parsed;
    }
    const root = parsed.value;
    if (
      root.localName !== "Relationships" ||
      root.namespaceURI !== OOXML_NS.pr
    ) {
      return Result.err(
        new TextOracleError({
          message: "Unsupported DOCX relationship document",
          reason: "unsupported",
        }),
      );
    }
    for (const relation of root.children) {
      const valid = validateStoryRelation({
        relation,
        relationshipPartPath: file.name,
        archive,
      });
      if (valid.isErr()) {
        return valid;
      }
    }
  }
  return Result.ok();
};

const validateStyleVisibility = async (
  archive: DocxArchive,
): Promise<Result<void, TextOracleError>> => {
  if (!archive.zip.file("word/styles.xml")) {
    return Result.ok();
  }
  const xml = await readPart(archive, "word/styles.xml");
  if (xml.isErr()) {
    return xml;
  }
  const parsed = parsePartXml(xml.value, 0);
  if (parsed.isErr()) {
    return parsed;
  }
  if (/<(?:[\w-]+:)?(?:vanish|specVanish)\b/u.test(xml.value)) {
    return Result.err(
      new TextOracleError({
        message: "DOCX styles require hidden-text rendering",
        reason: "unsupported",
      }),
    );
  }
  return Result.ok();
};

type ElementDisposition = { type: "skip" } | { type: "walk"; text: string };
const readElementText = (
  node: slimdom.Element,
): Result<ElementDisposition, TextOracleError> => {
  const wordElement = WORD_NAMESPACES.has(node.namespaceURI ?? "");
  if (wordElement && SKIPPED_WORD_ELEMENTS.has(node.localName)) {
    return Result.ok({ type: "skip" });
  }
  if (wordElement && UNSUPPORTED_WORD_ELEMENTS.has(node.localName)) {
    return Result.err(
      new TextOracleError({
        message: "DOCX contains text requiring unsupported rendering semantics",
        reason: "unsupported",
      }),
    );
  }
  const noteType = node.getAttributeNS(node.namespaceURI, "type");
  if (
    wordElement &&
    ["footnote", "endnote"].includes(node.localName) &&
    ["separator", "continuationSeparator"].includes(noteType ?? "")
  ) {
    return Result.ok({ type: "skip" });
  }
  if (
    node.namespaceURI === OOXML_NS.mc &&
    node.localName === "AlternateContent"
  ) {
    return Result.err(
      new TextOracleError({
        message: "DOCX alternate rendering requires a renderer decision",
        reason: "unsupported",
      }),
    );
  }
  if (node.localName === "t" && TEXT_NAMESPACES.has(node.namespaceURI ?? "")) {
    if (node.children.length !== 0) {
      return Result.err(
        new TextOracleError({
          message: "DOCX text leaf contains elements",
          reason: "malformed",
        }),
      );
    }
    return Result.ok({ type: "walk", text: node.textContent ?? "" });
  }
  if (node.localName === "p" && TEXT_NAMESPACES.has(node.namespaceURI ?? "")) {
    return Result.ok({ type: "walk", text: "\n" });
  }
  if (wordElement && node.localName === "noBreakHyphen") {
    return Result.ok({ type: "walk", text: "\u2011" });
  }
  if (wordElement && ["tab", "ptab", "br", "cr"].includes(node.localName)) {
    return Result.ok({ type: "walk", text: "\n" });
  }
  return Result.ok({ type: "walk", text: "" });
};

type ScanBudget = { nodes: number; textCharacters: number };
type ExtractPartTextOptions = { xml: string; budget: ScanBudget };
const extractPartText = ({
  xml,
  budget,
}: ExtractPartTextOptions): Result<string, TextOracleError> => {
  const parsed = parsePartXml(xml, budget.nodes);
  if (parsed.isErr()) {
    return parsed;
  }
  const output: string[] = [];
  const stack = [{ node: parsed.value, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) {
      break;
    }
    const { node, depth } = frame;
    budget.nodes += 1;
    if (
      budget.nodes > TEXT_ORACLE_LIMITS.nodes ||
      depth > TEXT_ORACLE_LIMITS.depth
    ) {
      return Result.err(
        new TextOracleError({
          message: "DOCX XML traversal limit exceeded",
          reason: "resource_limit",
        }),
      );
    }
    const disposition = readElementText(node);
    if (disposition.isErr()) {
      return disposition;
    }
    if (disposition.value.type === "skip") {
      continue;
    }
    const { text } = disposition.value;
    budget.textCharacters += text.length;
    if (budget.textCharacters > TEXT_ORACLE_LIMITS.textCharacters) {
      return Result.err(
        new TextOracleError({
          message: "DOCX text limit exceeded",
          reason: "resource_limit",
        }),
      );
    }
    output.push(text);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return Result.ok(output.join(""));
};

/** This reads OOXML directly: a filtered Folio model cannot certify its own omissions. */
export const readDocxText = async (
  raw: Uint8Array,
): Promise<Result<TextBaseline, TextOracleError>> => {
  const archive = await Result.tryPromise({
    try: () =>
      loadDocxArchive(raw, {
        maxEntryBytes: TEXT_ORACLE_LIMITS.rawBytes,
        maxTotalBytes: TEXT_ORACLE_LIMITS.rawBytes,
      }),
    catch: archiveError,
  });
  if (archive.isErr()) {
    return archive;
  }
  if (!archive.value.zip.file("word/document.xml")) {
    return Result.err(
      new TextOracleError({
        message: "DOCX main document part is missing",
        reason: "unsupported",
      }),
    );
  }
  const styles = await validateStyleVisibility(archive.value);
  if (styles.isErr()) {
    return styles;
  }
  const layout = await validateStoryLayout(archive.value);
  if (layout.isErr()) {
    return layout;
  }
  const output: string[] = [];
  const budget = { nodes: 0, textCharacters: 0 };
  for (const part of archive.value.zip.file(STORY_PART_PATTERN)) {
    const xml = await readPart(archive.value, part.name);
    if (xml.isErr()) {
      return xml;
    }
    const text = extractPartText({ xml: xml.value, budget });
    if (text.isErr()) {
      return text;
    }
    budget.textCharacters += 1;
    if (budget.textCharacters > TEXT_ORACLE_LIMITS.textCharacters) {
      return Result.err(
        new TextOracleError({
          message: "DOCX text limit exceeded",
          reason: "resource_limit",
        }),
      );
    }
    output.push(text.value, "\n");
  }
  return Result.ok({ text: output.join("") });
};
