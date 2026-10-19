import { panic } from "better-result";
import { load } from "cheerio";
import { isTag } from "domhandler";
import * as slimdom from "slimdom";

import { loadDocxArchive } from "@/api/lib/docx-archive";
import { DOCUMENT_METADATA_ENTRY_MAX_BYTES } from "@/api/lib/files/document-properties";
import type { ConvertibleMime } from "@/api/lib/files/pdf-derivative-policy";

type ConversionInputResult =
  | { kind: "convert" }
  | {
      kind: "refuse";
      reason: "external_reference";
      format: ConvertibleMime;
    };

type Detector = (bytes: Uint8Array) => Promise<boolean> | boolean;

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const latin1 = (bytes: Uint8Array): string =>
  new TextDecoder("windows-1252").decode(bytes);

const isSchemeCharacter = (character: string): boolean =>
  (character >= "a" && character <= "z") ||
  (character >= "0" && character <= "9") ||
  character === "+" ||
  character === "-" ||
  character === ".";

const isLocalReference = (value: string): boolean => {
  let normalized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) {
      normalized += character;
    }
  }
  normalized = normalized.trim().toLowerCase();
  if (
    normalized.startsWith("#") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("cid:")
  ) {
    return true;
  }
  if (normalized.startsWith("//") || normalized.startsWith("\\\\")) {
    return false;
  }
  const colon = normalized.indexOf(":");
  const first = normalized.charAt(0);
  if (colon <= 0 || first < "a" || first > "z") {
    return true;
  }
  for (let index = 1; index < colon; index++) {
    if (!isSchemeCharacter(normalized[index] ?? "")) {
      return true;
    }
  }
  return false;
};

const normalizeCss = (source: string): string | null => {
  let normalized = "";
  for (let cursor = 0; cursor < source.length; cursor++) {
    if (source[cursor] === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2);
      if (end === -1) {
        return null;
      }
      normalized += " ";
      cursor = end + 1;
      continue;
    }
    if (source[cursor] !== "\\") {
      normalized += source[cursor];
      continue;
    }
    cursor++;
    if (cursor >= source.length) {
      return null;
    }
    if (source[cursor] === "\n" || source[cursor] === "\f") {
      continue;
    }
    if (source[cursor] === "\r") {
      if (source[cursor + 1] === "\n") {
        cursor++;
      }
      continue;
    }
    const hex = /^[\da-f]{1,6}/iu.exec(source.slice(cursor))?.[0];
    if (hex === undefined) {
      normalized += source[cursor];
      continue;
    }
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint === 0 || codePoint > 0x10_ff_ff) {
      return null;
    }
    normalized += String.fromCodePoint(codePoint);
    cursor += hex.length - 1;
    if (/\s/u.test(source[cursor + 1] ?? "")) {
      cursor++;
    }
  }
  return normalized;
};

const nextCssReference = (
  lower: string,
  cursor: number,
): { at: number; markerLength: number } | null => {
  const urlAt = lower.indexOf("url(", cursor);
  const importAt = lower.indexOf("@import", cursor);
  if (urlAt === -1 && importAt === -1) {
    return null;
  }
  if (urlAt === -1) {
    return { at: importAt, markerLength: 7 };
  }
  if (importAt === -1 || urlAt < importAt) {
    return { at: urlAt, markerLength: 4 };
  }
  return { at: importAt, markerLength: 7 };
};

const cssHasExternalReference = (source: string): boolean => {
  const normalized = normalizeCss(source);
  if (normalized === null) {
    return true;
  }
  const lower = normalized.toLowerCase();
  let cursor = 0;
  while (cursor < lower.length) {
    const reference = nextCssReference(lower, cursor);
    if (reference === null) {
      return false;
    }
    const isUrl = reference.markerLength === 4;
    let valueAt = reference.at + reference.markerLength;
    while (valueAt < lower.length && /\s/u.test(lower[valueAt] ?? "")) {
      valueAt++;
    }
    if (!isUrl && lower.slice(valueAt, valueAt + 4) === "url(") {
      valueAt += 4;
      while (valueAt < lower.length && /\s/u.test(lower[valueAt] ?? "")) {
        valueAt++;
      }
    }
    if (valueAt >= lower.length) {
      return true;
    }
    const quote = lower[valueAt];
    const quoted = quote === '"' || quote === "'";
    if (quoted) {
      valueAt++;
    }
    let end = valueAt;
    if (quoted) {
      while (end < lower.length && lower[end] !== quote) {
        end++;
      }
    } else {
      while (end < lower.length && !/[\s;)]/u.test(lower[end] ?? "")) {
        end++;
      }
    }
    if (end === valueAt || (quoted && end >= lower.length)) {
      return true;
    }
    if (!isLocalReference(normalized.slice(valueAt, end))) {
      return true;
    }
    cursor = end + 1;
  }
  return false;
};

const htmlHasExternalReference = (bytes: Uint8Array): boolean => {
  const source = text(bytes);
  const $ = load(source);
  for (const node of $("*").toArray()) {
    if (!isTag(node)) {
      continue;
    }
    const name = node.name.toLowerCase();
    const attributes = Object.entries(node.attribs);
    const attribute = (wanted: string) =>
      attributes.find(([key]) => key.toLowerCase() === wanted)?.[1];
    if (
      name === "base" ||
      (name === "meta" && attribute("http-equiv")?.toLowerCase() === "refresh")
    ) {
      return true;
    }
    for (const [rawKey, value] of attributes) {
      const key = rawKey.toLowerCase();
      if (key === "style" && cssHasExternalReference(value)) {
        return true;
      }
      if (key === "srcset") {
        if (
          value
            .split(",")
            .some(
              (candidate) =>
                !isLocalReference(candidate.trim().split(/\s/u)[0] ?? ""),
            )
        ) {
          return true;
        }
        continue;
      }
      const reference =
        [
          "src",
          "poster",
          "data",
          "background",
          "xlink:href",
          "action",
          "formaction",
        ].includes(key) ||
        (key === "href" && name !== "a" && name !== "area");
      if (reference && !isLocalReference(value)) {
        return true;
      }
    }
    if (name === "style" && cssHasExternalReference($(node).text())) {
      return true;
    }
  }
  return false;
};

const xmlElements = function* (
  element: slimdom.Element | null,
): Generator<slimdom.Element> {
  if (element === null) {
    return;
  }
  yield element;
  for (const child of element.childNodes) {
    if (child instanceof slimdom.Element) {
      yield* xmlElements(child);
    }
  }
};

const relationshipHasExternalReference = (source: string): boolean => {
  const document = slimdom.parseXmlDocument(source);
  for (const element of xmlElements(document.documentElement)) {
    if (element.localName !== "Relationship") {
      continue;
    }
    const targetMode = xmlAttribute(element, "targetmode");
    const target = xmlAttribute(element, "target");
    if (
      targetMode?.toLowerCase() === "external" ||
      (target !== null && !isLocalReference(target))
    ) {
      return true;
    }
  }
  return false;
};

const xmlAttribute = (
  element: slimdom.Element,
  name: string,
): string | null => {
  for (const attribute of element.attributes) {
    if (attribute.name.toLowerCase() === name) {
      return attribute.value;
    }
  }
  return null;
};

const firstTokenMatches = (
  value: string,
  keywords: ReadonlySet<string>,
): boolean => {
  let cursor = 0;
  while (/\s/u.test(value[cursor] ?? "")) {
    cursor++;
  }
  let end = cursor;
  while (/[a-z]/iu.test(value[end] ?? "")) {
    end++;
  }
  return keywords.has(value.slice(cursor, end).toUpperCase());
};

const OOXML_FIELD_KEYWORDS: ReadonlySet<string> = new Set([
  "INCLUDEPICTURE",
  "INCLUDETEXT",
  "LINK",
]);

const ooxmlFieldHasExternalReference = (source: string): boolean => {
  const document = slimdom.parseXmlDocument(source);
  for (const element of xmlElements(document.documentElement)) {
    if (element.localName !== "fldSimple") {
      continue;
    }
    const instruction = xmlAttribute(element, "w:instr");
    if (
      instruction !== null &&
      firstTokenMatches(instruction, OOXML_FIELD_KEYWORDS)
    ) {
      return true;
    }
  }
  const instructions: { instruction: string; closed: boolean }[] = [];
  for (const element of xmlElements(document.documentElement)) {
    const name = element.localName.toLowerCase();
    if (name === "fldchar") {
      const type = xmlAttribute(element, "w:fldchartype")?.toLowerCase();
      if (type === "begin") {
        instructions.push({ instruction: "", closed: false });
      } else if (type === "separate") {
        const field = instructions.at(-1);
        if (field !== undefined && !field.closed) {
          if (firstTokenMatches(field.instruction, OOXML_FIELD_KEYWORDS)) {
            return true;
          }
          field.closed = true;
        }
      } else if (type === "end") {
        const field = instructions.pop();
        if (
          field !== undefined &&
          !field.closed &&
          firstTokenMatches(field.instruction, OOXML_FIELD_KEYWORDS)
        ) {
          return true;
        }
      }
      continue;
    }
    if (name === "instrtext") {
      const value = element.textContent ?? "";
      const fieldIndex = instructions.length - 1;
      if (fieldIndex >= 0) {
        const field = instructions[fieldIndex];
        if (field !== undefined && !field.closed) {
          field.instruction += value;
        }
      } else if (firstTokenMatches(value, OOXML_FIELD_KEYWORDS)) {
        return true;
      }
    }
  }
  return false;
};

const isOoxmlInspectedPath = (path: string): boolean => {
  if (path.endsWith(".rels") || path === "word/document.xml") {
    return true;
  }
  if (!path.startsWith("word/")) {
    return false;
  }
  const name = path.slice("word/".length);
  return (
    (name.startsWith("header") || name.startsWith("footer")) &&
    name.endsWith(".xml")
  );
};

const isOdfInspectedPath = (path: string): boolean =>
  path === "content.xml" ||
  path === "styles.xml" ||
  (path.endsWith("/content.xml") && path.includes("/"));

type PartSize = "body" | "metadata";

type InspectedPart =
  | { kind: "missing" }
  | { kind: "too_large" }
  | { kind: "source"; value: string };

const readInspectedPart = async (
  archive: Awaited<ReturnType<typeof loadDocxArchive>>,
  path: string,
  partSize: PartSize,
): Promise<InspectedPart> => {
  if (partSize === "body") {
    const value = await archive.readEntryString(path);
    return value === null ? { kind: "missing" } : { kind: "source", value };
  }
  const entry = archive.zip.file(path);
  if (entry === null) {
    return { kind: "missing" };
  }
  return await new Promise<InspectedPart>((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer");
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DOCUMENT_METADATA_ENTRY_MAX_BYTES) {
        stream.removeAllListeners("data");
        stream.pause();
        resolve({ kind: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () =>
      resolve({
        kind: "source",
        value: Buffer.concat(chunks, size).toString("utf-8"),
      }),
    );
    stream.on("error", reject);
  });
};

const archiveHas = async (
  bytes: Uint8Array,
  select: (path: string) => boolean,
  partSize: (path: string) => PartSize,
  inspect: (path: string, source: string) => boolean,
): Promise<boolean> => {
  const archive = await loadDocxArchive(bytes);
  const selectedPaths = Object.keys(archive.zip.files).filter(select);
  for (const path of selectedPaths) {
    const part = await readInspectedPart(archive, path, partSize(path));
    switch (part.kind) {
      case "missing":
        break;
      case "too_large":
        return true;
      case "source":
        if (inspect(path, part.value)) {
          return true;
        }
        break;
      default:
        part satisfies never;
        panic("Unexpected inspected part");
    }
  }
  return false;
};

const ooxmlHasExternalReference = async (bytes: Uint8Array): Promise<boolean> =>
  await archiveHas(
    bytes,
    isOoxmlInspectedPath,
    (path) => (path.endsWith(".rels") ? "metadata" : "body"),
    (path, source) =>
      path.endsWith(".rels")
        ? relationshipHasExternalReference(source)
        : ooxmlFieldHasExternalReference(source),
  );

const odfHasExternalReference = async (bytes: Uint8Array): Promise<boolean> =>
  await archiveHas(
    bytes,
    isOdfInspectedPath,
    (path) => (path === "styles.xml" ? "metadata" : "body"),
    (_path, source) => {
      const document = slimdom.parseXmlDocument(source);
      for (const element of xmlElements(document.documentElement)) {
        if (element.localName.toLowerCase() === "a") {
          continue;
        }
        const href = xmlAttribute(element, "xlink:href");
        if (href !== null && !isLocalReference(href)) {
          return true;
        }
      }
      return false;
    },
  );

const RTF_FIELD_KEYWORDS: ReadonlySet<string> = new Set([
  "INCLUDEPICTURE",
  "INCLUDETEXT",
  "IMPORT",
  "LINK",
]);

const rtfHasExternalReference = (bytes: Uint8Array): boolean => {
  const source = latin1(bytes);
  const lower = source.toLowerCase();
  if (lower.includes("\\objlink")) {
    return true;
  }
  let cursor = 0;
  while ((cursor = lower.indexOf("{\\", cursor)) !== -1) {
    let marker: string | null = null;
    if (lower.startsWith("{\\*\\fldinst", cursor)) {
      marker = "{\\*\\fldinst";
    } else if (lower.startsWith("{\\fldinst", cursor)) {
      marker = "{\\fldinst";
    }
    if (marker === null) {
      cursor += 2;
      continue;
    }
    let end = cursor + marker.length;
    let depth = 1;
    let escaped = false;
    while (end < source.length && depth > 0) {
      const character = source[end];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "{") {
        depth++;
      } else if (character === "}") {
        depth--;
      }
      end++;
    }
    if (
      firstTokenMatches(
        source.slice(cursor + marker.length, end - 1),
        RTF_FIELD_KEYWORDS,
      )
    ) {
      return true;
    }
    cursor = end;
  }
  return false;
};

const LEGACY_FIELD_KEYWORDS: ReadonlySet<string> = new Set([
  "INCLUDEPICTURE",
  "INCLUDETEXT",
  "LINK",
]);
const DOC_FIELD_KEYWORDS: ReadonlySet<string> = new Set([
  ...LEGACY_FIELD_KEYWORDS,
  "IMPORT",
]);

const binaryFieldsMatch = (
  bytes: Uint8Array,
  wide: boolean,
  keywords: ReadonlySet<string>,
): boolean => {
  const step = wide ? 2 : 1;
  for (let cursor = 0; cursor + step <= bytes.length; cursor += step) {
    if (bytes[cursor] !== 0x13 || (wide && bytes[cursor + 1] !== 0)) {
      continue;
    }
    const field: number[] = [];
    cursor += step;
    while (cursor + step <= bytes.length) {
      if (bytes[cursor] === 0x14 && (!wide || bytes[cursor + 1] === 0)) {
        break;
      }
      if (!wide || bytes[cursor + 1] === 0) {
        field.push(bytes[cursor] ?? 0);
      }
      cursor += step;
    }
    if (firstTokenMatches(latin1(new Uint8Array(field)), keywords)) {
      return true;
    }
  }
  return false;
};

const docHasExternalReference = (bytes: Uint8Array): boolean =>
  binaryFieldsMatch(bytes, false, DOC_FIELD_KEYWORDS) ||
  binaryFieldsMatch(bytes, true, DOC_FIELD_KEYWORDS);
const legacyOfficeHasExternalReference = (bytes: Uint8Array): boolean =>
  binaryFieldsMatch(bytes, false, LEGACY_FIELD_KEYWORDS) ||
  binaryFieldsMatch(bytes, true, LEGACY_FIELD_KEYWORDS);

const safe = (): false => false;

const DETECTORS = {
  "application/msword": docHasExternalReference,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ooxmlHasExternalReference,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    ooxmlHasExternalReference,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ooxmlHasExternalReference,
  "application/vnd.ms-excel": legacyOfficeHasExternalReference,
  "application/vnd.ms-powerpoint": legacyOfficeHasExternalReference,
  "application/vnd.oasis.opendocument.presentation": odfHasExternalReference,
  "application/vnd.oasis.opendocument.spreadsheet": odfHasExternalReference,
  "application/vnd.oasis.opendocument.text": odfHasExternalReference,
  "application/rtf": rtfHasExternalReference,
  "application/vnd.apple.pages": safe,
  "application/xhtml+xml": htmlHasExternalReference,
  "image/bmp": safe,
  "image/gif": safe,
  "image/jpeg": safe,
  "image/png": safe,
  "image/tiff": safe,
  "image/webp": safe,
  "text/csv": safe,
  "text/html": htmlHasExternalReference,
  "text/plain": safe,
} as const satisfies Record<ConvertibleMime, Detector>;

export const checkConversionInput = async (
  mime: ConvertibleMime,
  bytes: Uint8Array,
): Promise<ConversionInputResult> =>
  (await DETECTORS[mime](bytes))
    ? { kind: "refuse", reason: "external_reference", format: mime }
    : { kind: "convert" };
