import { loadDocxArchive } from "@/api/lib/docx-archive";
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

const hasNetworkLocation = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("//") ||
    normalized.startsWith("http:") ||
    normalized.startsWith("https:") ||
    normalized.startsWith("ftp:") ||
    normalized.startsWith("file:")
  );
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
      if (hasNetworkLocation(lower.slice(valueAt))) {
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
    if (lower.startsWith("<link")) {
      attributes.push("href");
    }
    for (const name of attributes) {
      const value = attributeValue(tag, name);
      if (value !== null && hasNetworkLocation(value)) {
        return true;
      }
    }
    const srcset = attributeValue(tag, "srcset");
    if (
      srcset !== null &&
      srcset.split(",").some((part) => hasNetworkLocation(part.trim()))
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

const archiveHas = async (
  bytes: Uint8Array,
  inspect: (path: string, source: string) => boolean,
): Promise<boolean> => {
  const archive = await loadDocxArchive(bytes);
  const paths = Object.keys(archive.zip.files);
  for (const path of paths) {
    const source = await archive.readEntryString(path);
    if (source !== null && inspect(path, source)) {
      return true;
    }
  }
  return false;
};

const ooxmlHasExternalReference = async (bytes: Uint8Array): Promise<boolean> =>
  await archiveHas(
    bytes,
    (path, source) =>
      path.endsWith(".rels") && relationshipHasExternalReference(source),
  );

const odfHasExternalReference = async (bytes: Uint8Array): Promise<boolean> =>
  await archiveHas(bytes, (_path, source) => {
    for (const tag of tags(source)) {
      if (tag.toLowerCase().startsWith("<text:a")) {
        continue;
      }
      const href = attributeValue(tag, "xlink:href");
      if (href !== null && hasNetworkLocation(href)) {
        return true;
      }
    }
    return false;
  });

const rtfHasExternalReference = (bytes: Uint8Array): boolean => {
  const source = latin1(bytes).toUpperCase();
  return ["INCLUDEPICTURE", "INCLUDETEXT", "IMPORT", " LINK", "\\OBJLINK"].some(
    (field) => source.includes(field),
  );
};

const docHasExternalReference = (bytes: Uint8Array): boolean => {
  const singleByte = latin1(bytes).toUpperCase();
  const wide = new TextDecoder("utf-16le").decode(bytes).toUpperCase();
  return ["INCLUDEPICTURE", "INCLUDETEXT", " LINK"].some(
    (field) => singleByte.includes(field) || wide.includes(field),
  );
};

const safe = (): false => false;

const DETECTORS = {
  "application/msword": docHasExternalReference,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ooxmlHasExternalReference,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    ooxmlHasExternalReference,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ooxmlHasExternalReference,
  "application/vnd.ms-excel": docHasExternalReference,
  "application/vnd.ms-powerpoint": docHasExternalReference,
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
