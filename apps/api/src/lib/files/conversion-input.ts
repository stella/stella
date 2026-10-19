import { panic } from "better-result";

import { loadDocxArchive } from "@/api/lib/docx-archive";
import { DOCUMENT_METADATA_ENTRY_MAX_BYTES } from "@/api/lib/files/document-properties";
import type { ConvertibleMime } from "@/api/lib/files/pdf-derivative-policy";

export type ConversionInputResult =
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

const CHARACTER_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  colon: ":",
  gt: ">",
  lt: "<",
  quot: '"',
};

const decodeCharacterReferences = (value: string): string => {
  let decoded = "";
  let cursor = 0;
  while (cursor < value.length) {
    if (value[cursor] !== "&") {
      decoded += value[cursor];
      cursor++;
      continue;
    }
    const end = value.indexOf(";", cursor + 1);
    if (end === -1) {
      decoded += value[cursor];
      cursor++;
      continue;
    }
    const reference = value.slice(cursor + 1, end);
    let replacement = CHARACTER_REFERENCES[reference.toLowerCase()];
    const radix =
      reference.startsWith("#x") || reference.startsWith("#X") ? 16 : 10;
    const digits = radix === 16 ? reference.slice(2) : reference.slice(1);
    if (reference.startsWith("#")) {
      const code = Number.parseInt(digits, radix);
      replacement =
        Number.isFinite(code) && code > 0 && code <= 0x10_ff_ff
          ? String.fromCodePoint(code)
          : undefined;
    }
    decoded += replacement ?? value.slice(cursor, end + 1);
    cursor = end + 1;
  }
  return decoded;
};

const isSchemeCharacter = (character: string): boolean =>
  (character >= "a" && character <= "z") ||
  (character >= "0" && character <= "9") ||
  character === "+" ||
  character === "-" ||
  character === ".";

const isLocalReference = (value: string): boolean => {
  let normalized = "";
  for (const character of decodeCharacterReferences(value)) {
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
  if (colon <= 0 || normalized[0] < "a" || normalized[0] > "z") {
    return true;
  }
  for (let index = 1; index < colon; index++) {
    if (!isSchemeCharacter(normalized[index] ?? "")) {
      return true;
    }
  }
  return false;
};

const attributeValue = (tag: string, name: string): string | null => {
  const lower = tag.toLowerCase();
  let at = 0;
  while ((at = lower.indexOf(name, at)) !== -1) {
    const before = at === 0 ? " " : lower[at - 1];
    const after = lower[at + name.length];
    if (
      (before === " " || before === "\t" || before === "\n") &&
      after !== undefined
    ) {
      let cursor = at + name.length;
      while (
        tag[cursor] === " " ||
        tag[cursor] === "\t" ||
        tag[cursor] === "\n"
      ) {
        cursor++;
      }
      if (tag[cursor] !== "=") {
        at += name.length;
        continue;
      }
      cursor++;
      while (
        tag[cursor] === " " ||
        tag[cursor] === "\t" ||
        tag[cursor] === "\n"
      ) {
        cursor++;
      }
      const quote = tag[cursor];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, cursor + 1);
        return end === -1 ? null : tag.slice(cursor + 1, end);
      }
      let end = cursor;
      while (end < tag.length && !" \t\n>".includes(tag[end] ?? ">")) {
        end++;
      }
      return tag.slice(cursor, end);
    }
    at += name.length;
  }
  return null;
};

const tags = (source: string): string[] => {
  const result: string[] = [];
  let cursor = 0;
  while ((cursor = source.indexOf("<", cursor)) !== -1) {
    const end = source.indexOf(">", cursor + 1);
    if (end === -1) {
      break;
    }
    result.push(source.slice(cursor, end + 1));
    cursor = end + 1;
  }
  return result;
};

const cssHasExternalReference = (source: string): boolean => {
  const lower = source.toLowerCase();
  for (const marker of ["url(", "@import"]) {
    let at = 0;
    while ((at = lower.indexOf(marker, at)) !== -1) {
      let valueAt = at + marker.length;
      while (" \t\n(".includes(lower[valueAt] ?? "")) {
        valueAt++;
      }
      const quote = lower[valueAt];
      if (quote === '"' || quote === "'") {
        valueAt++;
      }
      if (!isLocalReference(lower.slice(valueAt).split(/[\s;)]/u)[0] ?? "")) {
        return true;
      }
      at = valueAt + 1;
    }
  }
  return false;
};

const htmlHasExternalReference = (bytes: Uint8Array): boolean => {
  const source = text(bytes);
  if (cssHasExternalReference(source)) {
    return true;
  }
  for (const tag of tags(source)) {
    const lower = tag.toLowerCase();
    if (
      lower.startsWith("<base") ||
      (lower.startsWith("<meta") &&
        attributeValue(tag, "http-equiv")?.toLowerCase() === "refresh")
    ) {
      return true;
    }
    const attributes = ["src", "poster", "data", "background"];
    if (
      lower.startsWith("<link") ||
      lower.startsWith("<embed") ||
      lower.startsWith("<input") ||
      lower.startsWith("<image")
    ) {
      attributes.push("href", "xlink:href");
    }
    for (const name of attributes) {
      const value = attributeValue(tag, name);
      if (value !== null && !isLocalReference(value)) {
        return true;
      }
    }
    const srcset = attributeValue(tag, "srcset");
    if (
      srcset !== null &&
      srcset
        .split(",")
        .some((part) => !isLocalReference(part.trim().split(/\s/u)[0] ?? ""))
    ) {
      return true;
    }
  }
  return false;
};

const relationshipHasExternalReference = (source: string): boolean => {
  for (const tag of tags(source)) {
    if (!tag.toLowerCase().startsWith("<relationship")) {
      continue;
    }
    if (attributeValue(tag, "targetmode")?.toLowerCase() !== "external") {
      continue;
    }
    const type = attributeValue(tag, "type")?.toLowerCase();
    if (type === undefined || !type.endsWith("/hyperlink")) {
      return true;
    }
  }
  return false;
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
  for (const tag of tags(source)) {
    if (!tag.toLowerCase().startsWith("<w:fldsimple")) {
      continue;
    }
    const instruction = attributeValue(tag, "w:instr");
    if (
      instruction !== null &&
      firstTokenMatches(instruction, OOXML_FIELD_KEYWORDS)
    ) {
      return true;
    }
  }
  const instructions: { instruction: string; closed: boolean }[] = [];
  const lower = source.toLowerCase();
  let cursor = 0;
  while ((cursor = lower.indexOf("<", cursor)) !== -1) {
    const tagEnd = source.indexOf(">", cursor + 1);
    if (tagEnd === -1) {
      break;
    }
    const tag = source.slice(cursor, tagEnd + 1);
    const lowerTag = tag.toLowerCase();
    if (lowerTag.startsWith("<w:fldchar")) {
      const type = attributeValue(tag, "w:fldchartype")?.toLowerCase();
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
      cursor = tagEnd + 1;
      continue;
    }
    if (lowerTag.startsWith("<w:instrtext")) {
      const textEnd = lower.indexOf("</w:instrtext>", tagEnd + 1);
      if (textEnd === -1) {
        break;
      }
      const value = decodeCharacterReferences(
        source.slice(tagEnd + 1, textEnd),
      );
      const fieldIndex = instructions.length - 1;
      if (fieldIndex >= 0) {
        const field = instructions[fieldIndex];
        if (field !== undefined && !field.closed) {
          field.instruction += value;
        }
      } else if (firstTokenMatches(value, OOXML_FIELD_KEYWORDS)) {
        return true;
      }
      cursor = textEnd + "</w:instrtext>".length;
      continue;
    }
    cursor = tagEnd + 1;
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
        stream.destroy();
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
      for (const tag of tags(source)) {
        if (tag.toLowerCase().startsWith("<text:a")) {
          continue;
        }
        const href = attributeValue(tag, "xlink:href");
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
