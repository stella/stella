/**
 * Embedded document properties: the metadata a file carries inside itself
 * (DOCX Author and Company, PDF Producer, ODF generator, ...), as opposed to
 * what stella records about the document or what AI extracted from its text.
 *
 * Reading is derived from the stored bytes on demand and nothing is persisted,
 * so no copy of the author or company names outlives the request that displayed
 * them. Scrubbing produces a cleaned copy for export and likewise never touches
 * the stored version: the file in the matter keeps its metadata, only the
 * bytes that leave do not.
 */
import { PDF } from "@libpdf/core";
import { panic, TaggedError } from "better-result";

import {
  AUTHORED_DOCUMENT_PROPERTY_KEYS,
  DOCUMENT_PROPERTY_KEYS,
  documentContainerFormat,
} from "@stll/api-contract";
import type {
  AuthoredDocumentPropertyKey,
  DocumentPropertiesResult,
  DocumentProperty,
  DocumentPropertyKey,
  DocumentPropertyValue,
} from "@stll/api-contract";

import { loadDocxArchive } from "@/api/lib/docx-archive";

class DocumentPropertiesParseError extends TaggedError(
  "DocumentPropertiesParseError",
)<{ message: string }> {}

/** Property XML is a few kilobytes; a hostile archive declaring more is not read. */
const PROPERTY_ENTRY_MAX_BYTES = 2 * 1024 * 1024;

const readPropertyEntry = async (
  archive: Awaited<ReturnType<typeof loadDocxArchive>>,
  path: string,
): Promise<string | null> => {
  const entry = archive.zip.file(path);
  if (entry === null) {
    return null;
  }
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer");
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > PROPERTY_ENTRY_MAX_BYTES) {
        const destroy: unknown = Reflect.get(stream, "destroy");
        if (typeof destroy === "function") {
          Reflect.apply(destroy, stream, []);
        }
        reject(
          new DocumentPropertiesParseError({
            message: `Property entry ${path} is too large`,
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
  return bytes.toString("utf-8");
};

// ── Value builders ──────────────────────────────────────

/**
 * Accumulates properties in {@link DOCUMENT_PROPERTY_KEYS} order and drops
 * blanks, so a document that wrote `<Company></Company>` shows no Company row
 * rather than an empty one.
 */
const collector = () => {
  const values = new Map<DocumentPropertyKey, DocumentPropertyValue>();

  const text = (key: DocumentPropertyKey, raw: string | null | undefined) => {
    const trimmed = raw?.trim();
    if (trimmed === undefined || trimmed.length === 0) {
      return;
    }
    values.set(key, { type: "text", value: trimmed });
  };

  const date = (
    key: DocumentPropertyKey,
    raw: string | Date | null | undefined,
  ) => {
    if (raw === null || raw === undefined) {
      return;
    }
    const parsed = raw instanceof Date ? raw : new Date(raw.trim());
    if (Number.isNaN(parsed.getTime())) {
      return;
    }
    values.set(key, { type: "date", value: parsed.toISOString() });
  };

  const count = (
    key: DocumentPropertyKey,
    raw: string | number | null | undefined,
  ) => {
    if (raw === null || raw === undefined) {
      return;
    }
    const parsed =
      typeof raw === "number" ? raw : Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return;
    }
    values.set(key, { type: "count", value: parsed });
  };

  const minutes = (key: DocumentPropertyKey, raw: number | null) => {
    if (raw === null || !Number.isFinite(raw) || raw <= 0) {
      return;
    }
    values.set(key, { type: "minutes", value: Math.round(raw) });
  };

  const properties = (): DocumentProperty[] =>
    DOCUMENT_PROPERTY_KEYS.flatMap((key) => {
      const value = values.get(key);
      return value === undefined ? [] : [{ key, value }];
    });

  return { text, date, count, minutes, properties };
};

// ── XML reading ─────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

// Capture groups, in order: a named entity, a decimal reference, a hex one.
const XML_ENTITY_RE = /&(?:([a-z]+)|#(\d+)|#x([\da-f]+));/giu;

const codePointToText = (digits: string, radix: number, fallback: string) => {
  const code = Number.parseInt(digits, radix);
  return Number.isFinite(code) && code > 0 && code <= 0x10_ff_ff
    ? String.fromCodePoint(code)
    : fallback;
};

const decodeXmlText = (value: string): string =>
  value.replace(
    XML_ENTITY_RE,
    (match: string, named?: string, dec?: string, hex?: string) => {
      if (named !== undefined) {
        return XML_ENTITIES[named.toLowerCase()] ?? match;
      }
      if (dec !== undefined) {
        return codePointToText(dec, 10, match);
      }
      return hex === undefined ? match : codePointToText(hex, 16, match);
    },
  );

const elementRegexCache = new Map<string, RegExp>();

/**
 * Text content of the first `<name>` element, or null when absent or empty.
 * A regex rather than a DOM parse: these documents are untrusted input and the
 * values wanted are flat leaf text, so there is nothing to gain from building
 * a tree (and no external-entity surface to defend).
 */
const elementText = (xml: string, name: string): string | null => {
  let regex = elementRegexCache.get(name);
  if (!regex) {
    regex = new RegExp(
      `<${name}(?:\\s[^>]*)?(?:/>|>(?<body>[\\s\\S]*?)</${name}>)`,
      "u",
    );
    elementRegexCache.set(name, regex);
  }
  const body = regex.exec(xml)?.groups?.["body"];
  return body === undefined ? null : decodeXmlText(body);
};

const attributeRegexCache = new Map<string, RegExp>();

/** Value of `attribute` on the first `<element>`, or null when absent. */
const elementAttribute = (
  xml: string,
  element: string,
  attribute: string,
): string | null => {
  const cacheKey = `${element}/${attribute}`;
  let regex = attributeRegexCache.get(cacheKey);
  if (!regex) {
    regex = new RegExp(
      `<${element}\\s[^>]*?${attribute}="(?<value>[^"]*)"`,
      "u",
    );
    attributeRegexCache.set(cacheKey, regex);
  }
  const value = regex.exec(xml)?.groups?.["value"];
  return value === undefined ? null : decodeXmlText(value);
};

const ISO_DURATION_RE =
  /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>[\d.]+)S)?)?$/u;

/** ISO-8601 duration (ODF `meta:editing-duration`) as whole minutes. */
const durationToMinutes = (raw: string | null): number | null => {
  const groups =
    raw === null ? undefined : ISO_DURATION_RE.exec(raw.trim())?.groups;
  if (!groups) {
    return null;
  }
  const total =
    Number(groups["days"] ?? 0) * 24 * 60 +
    Number(groups["hours"] ?? 0) * 60 +
    Number(groups["minutes"] ?? 0) +
    Number(groups["seconds"] ?? 0) / 60;
  return Number.isFinite(total) ? Math.round(total) : null;
};

// ── Per-format readers ──────────────────────────────────

/**
 * OOXML keeps the standard properties in two parts: `core.xml` (Dublin Core
 * plus the `cp:` extensions Word's "Summary" tab shows) and `app.xml` (the
 * producing application's own counters, Company and Manager among them).
 */
const readOoxmlProperties = async (
  bytes: ArrayBuffer,
): Promise<DocumentProperty[]> => {
  // The archive remains globally bounded by the shared DOCX limits, while
  // readPropertyEntry applies the much smaller limit only to metadata parts.
  const archive = await loadDocxArchive(bytes);
  const core = (await readPropertyEntry(archive, "docProps/core.xml")) ?? "";
  const app = (await readPropertyEntry(archive, "docProps/app.xml")) ?? "";

  const out = collector();
  out.text("title", elementText(core, "dc:title"));
  out.text("subject", elementText(core, "dc:subject"));
  out.text("description", elementText(core, "dc:description"));
  out.text("keywords", elementText(core, "cp:keywords"));
  out.text("category", elementText(core, "cp:category"));
  out.text("contentStatus", elementText(core, "cp:contentStatus"));
  out.text("author", elementText(core, "dc:creator"));
  out.text("lastModifiedBy", elementText(core, "cp:lastModifiedBy"));
  out.text("language", elementText(core, "dc:language"));
  out.text("revision", elementText(core, "cp:revision"));
  out.date("createdAt", elementText(core, "dcterms:created"));
  out.date("modifiedAt", elementText(core, "dcterms:modified"));
  out.date("lastPrintedAt", elementText(core, "cp:lastPrinted"));

  out.text("company", elementText(app, "Company"));
  out.text("manager", elementText(app, "Manager"));
  out.text("application", elementText(app, "Application"));
  out.text("applicationVersion", elementText(app, "AppVersion"));
  out.text("template", elementText(app, "Template"));
  out.count("pages", elementText(app, "Pages"));
  out.count("words", elementText(app, "Words"));
  out.count("characters", elementText(app, "Characters"));
  out.count("paragraphs", elementText(app, "Paragraphs"));
  out.count("slides", elementText(app, "Slides"));
  // TotalTime is already whole minutes, unlike ODF's ISO duration.
  const totalTime = elementText(app, "TotalTime");
  out.minutes(
    "editingMinutes",
    totalTime === null ? null : Number.parseInt(totalTime, 10),
  );

  return out.properties();
};

/** OpenDocument keeps everything in one `meta.xml` part. */
const readOdfProperties = async (
  bytes: ArrayBuffer,
): Promise<DocumentProperty[]> => {
  // See readOoxmlProperties: unrelated document content is not metadata.
  const archive = await loadDocxArchive(bytes);
  const meta = (await readPropertyEntry(archive, "meta.xml")) ?? "";

  const out = collector();
  out.text("title", elementText(meta, "dc:title"));
  out.text("subject", elementText(meta, "dc:subject"));
  out.text("description", elementText(meta, "dc:description"));
  out.text("keywords", elementText(meta, "meta:keyword"));
  out.text("language", elementText(meta, "dc:language"));
  // ODF splits authorship the other way round from OOXML: `meta:initial-creator`
  // is who started the document, `dc:creator` who last saved it.
  out.text("author", elementText(meta, "meta:initial-creator"));
  out.text("lastModifiedBy", elementText(meta, "dc:creator"));
  out.text("application", elementText(meta, "meta:generator"));
  out.text("revision", elementText(meta, "meta:editing-cycles"));
  out.date("createdAt", elementText(meta, "meta:creation-date"));
  out.date("modifiedAt", elementText(meta, "dc:date"));
  out.date("lastPrintedAt", elementText(meta, "meta:print-date"));
  out.minutes(
    "editingMinutes",
    durationToMinutes(elementText(meta, "meta:editing-duration")),
  );

  const statistic = "meta:document-statistic";
  out.count("pages", elementAttribute(meta, statistic, "meta:page-count"));
  out.count("words", elementAttribute(meta, statistic, "meta:word-count"));
  out.count(
    "characters",
    elementAttribute(meta, statistic, "meta:character-count"),
  );
  out.count(
    "paragraphs",
    elementAttribute(meta, statistic, "meta:paragraph-count"),
  );

  return out.properties();
};

/**
 * PDF exposes the Info dictionary plus the page count. `Creator` names the
 * application the content came from and `Producer` the one that wrote the PDF,
 * which is what reveals a converted-from-Word original.
 */
const readPdfProperties = async (
  bytes: ArrayBuffer,
): Promise<DocumentPropertiesResult> => {
  const pdf = await PDF.load(new Uint8Array(bytes));
  if (pdf.isEncrypted) {
    return { status: "password-protected" };
  }

  const out = collector();
  out.text("title", pdf.getTitle());
  out.text("subject", pdf.getSubject());
  out.text("keywords", pdf.getKeywords()?.join(", "));
  out.text("author", pdf.getAuthor());
  out.text("application", pdf.getCreator());
  out.text("producer", pdf.getProducer());
  out.text("language", pdf.getLanguage());
  out.date("createdAt", pdf.getCreationDate());
  out.date("modifiedAt", pdf.getModificationDate());
  out.count("pages", pdf.getPageCount());

  return { status: "available", properties: out.properties(), editable: false };
};

type ExtractDocumentPropertiesOptions = {
  bytes: ArrayBuffer;
  mimeType: string;
};

export const constrainDocumentPropertiesEditability = (
  result: DocumentPropertiesResult,
  authorized: boolean,
): DocumentPropertiesResult =>
  result.status === "available"
    ? { ...result, editable: result.editable && authorized }
    : result;

/**
 * Read the embedded properties of one file. Never throws: a malformed or
 * unexpectedly shaped document is reported as `unreadable`, because a metadata
 * panel failing to open is worse than one saying it could not read the file.
 */
export const extractDocumentProperties = async ({
  bytes,
  mimeType,
}: ExtractDocumentPropertiesOptions): Promise<DocumentPropertiesResult> => {
  const format = documentContainerFormat(mimeType);
  if (format === null) {
    return { status: "unsupported-format" };
  }

  try {
    switch (format) {
      // Only OOXML is writable; see writeDocumentProperties for why.
      case "ooxml":
        return {
          status: "available",
          properties: await readOoxmlProperties(bytes),
          editable: true,
        };
      case "odf":
        return {
          status: "available",
          properties: await readOdfProperties(bytes),
          editable: false,
        };
      case "pdf":
        return await readPdfProperties(bytes);
      default:
        format satisfies never;
        return panic(`Unhandled format: ${String(format)}`);
    }
  } catch {
    return { status: "unreadable" };
  }
};

// ── Scrubbing ───────────────────────────────────────────

/**
 * Either the cleaned bytes or why they could not be produced. `signed` is its
 * own answer rather than a generic failure: removing metadata from a signed PDF
 * means rewriting the byte ranges the signature covers, which would silently
 * invalidate it.
 */
export type ScrubDocumentPropertiesResult =
  | { status: "scrubbed"; bytes: Uint8Array }
  | { status: "unsupported-format" }
  | { status: "password-protected" }
  | { status: "signed" }
  | { status: "unreadable" };

/**
 * OOXML core properties that name a person, an organisation or the drafting
 * history. Counts and the producing application stay: they identify nobody, and
 * a file stripped of them looks tampered with rather than cleaned.
 */
const DC_NS = "http://purl.org/dc/elements/1.1/";
const DCTERMS_NS = "http://purl.org/dc/terms/";
const OOXML_CORE_NS =
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const OOXML_APP_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const OOXML_CUSTOM_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
const ODF_META_NS = "urn:oasis:names:tc:opendocument:xmlns:meta:1.0";
const WORD_MAIN_NS =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WORD_2012_NS = "http://schemas.microsoft.com/office/word/2012/wordml";

type XmlElement = { namespace: string; localName: string };

const OOXML_CORE_TEXT_CLEARED = [
  { namespace: DC_NS, localName: "title" },
  { namespace: DC_NS, localName: "subject" },
  { namespace: DC_NS, localName: "creator" },
  { namespace: DC_NS, localName: "description" },
  { namespace: OOXML_CORE_NS, localName: "keywords" },
  { namespace: OOXML_CORE_NS, localName: "category" },
  { namespace: OOXML_CORE_NS, localName: "contentStatus" },
  { namespace: OOXML_CORE_NS, localName: "lastModifiedBy" },
] as const satisfies readonly XmlElement[];

/**
 * Typed properties cannot be represented by an empty element. Remove them so
 * the package does not retain an invalid date or revision lexical value.
 */
const OOXML_CORE_REMOVED = [
  { namespace: OOXML_CORE_NS, localName: "revision" },
  { namespace: OOXML_CORE_NS, localName: "lastPrinted" },
  { namespace: DCTERMS_NS, localName: "created" },
  { namespace: DCTERMS_NS, localName: "modified" },
] as const satisfies readonly XmlElement[];

/** Extended properties naming the firm, the supervisor or the time spent. */
const OOXML_APP_CLEARED = ["Company", "Manager", "Template"].map(
  (localName) => ({ namespace: OOXML_APP_NS, localName }),
);

const ODF_META_CLEARED = [
  { namespace: DC_NS, localName: "title" },
  { namespace: DC_NS, localName: "subject" },
  { namespace: DC_NS, localName: "description" },
  { namespace: ODF_META_NS, localName: "keyword" },
  { namespace: ODF_META_NS, localName: "initial-creator" },
  { namespace: DC_NS, localName: "creator" },
  { namespace: ODF_META_NS, localName: "printed-by" },
  { namespace: ODF_META_NS, localName: "creation-date" },
  { namespace: DC_NS, localName: "date" },
  { namespace: ODF_META_NS, localName: "print-date" },
  { namespace: ODF_META_NS, localName: "editing-cycles" },
  { namespace: ODF_META_NS, localName: "editing-duration" },
] as const satisfies readonly XmlElement[];

const clearRegexCache = new Map<string, RegExp>();

/**
 * Empty every occurrence of `<name>…</name>`, leaving the element in place.
 * Deleting the elements outright is the other option, but Word and LibreOffice
 * both treat a missing part as "never had properties" and helpfully write fresh
 * ones from the current user on the next save; an empty element stays empty.
 */
const clearElements = (xml: string, names: readonly string[]): string => {
  let cleared = xml;
  for (const name of names) {
    let regex = clearRegexCache.get(name);
    if (!regex) {
      regex = new RegExp(
        `(<${name}(?:\\s[^>]*)?>)[\\s\\S]*?(</${name}>)`,
        "gu",
      );
      clearRegexCache.set(name, regex);
    }
    cleared = cleared.replace(regex, "$1$2");
  }
  return cleared;
};

const XML_NAMESPACE_DECLARATION_RE =
  /\bxmlns(?::(?<prefix>[A-Za-z_][\w.-]*))?\s*=\s*(?<quote>["'])(?<namespace>[^"']*)\k<quote>/gu;

const qualifiedNames = (xml: string, element: XmlElement): string[] =>
  [...xml.matchAll(XML_NAMESPACE_DECLARATION_RE)]
    .filter(({ groups }) => groups?.["namespace"] === element.namespace)
    .map(({ groups }) => {
      const prefix = groups?.["prefix"];
      return prefix === undefined
        ? element.localName
        : `${prefix}:${element.localName}`;
    });

const clearNamespacedElements = (
  xml: string,
  elements: readonly XmlElement[],
): string =>
  clearElements(
    xml,
    elements.flatMap((element) => qualifiedNames(xml, element)),
  );

const hasNamespacedElement = (xml: string, element: XmlElement): boolean =>
  qualifiedNames(xml, element).some((name) =>
    new RegExp(`<${name}(?:\\s|>)`, "u").test(xml),
  );

const removeNamespacedElements = (
  xml: string,
  element: XmlElement,
  keep?: (openTag: string) => boolean,
): string => {
  let result = xml;
  for (const name of qualifiedNames(xml, element)) {
    const regex = new RegExp(
      `<${name}(?<attributes>\\s[^>]*)?(?:/>|>[\\s\\S]*?</${name}>)`,
      "gu",
    );
    result = result.replace(regex, (match) =>
      keep?.(match) === true ? match : "",
    );
  }
  return result;
};

/** `<TotalTime>` is numeric: blanking it yields invalid OOXML, so zero it. */
const zeroNamespacedElement = (xml: string, element: XmlElement): string => {
  let result = xml;
  for (const name of qualifiedNames(xml, element)) {
    const regex = new RegExp(
      `(<${name}(?:\\s[^>]*)?>)[\\s\\S]*?(</${name}>)`,
      "gu",
    );
    result = result.replace(regex, "$10$2");
  }
  return result;
};

const isSignedZipArchive = (
  archive: Awaited<ReturnType<typeof loadDocxArchive>>,
): boolean =>
  Object.keys(archive.zip.files).some((path) => {
    const normalized = path.toLowerCase();
    return (
      normalized.startsWith("_xmlsignatures/") ||
      normalized === "meta-inf/documentsignatures.xml" ||
      normalized === "meta-inf/macrosignatures.xml" ||
      normalized === "meta-inf/packagesignatures.xml"
    );
  });

type ZipPart = {
  path: string;
  clear: (xml: string) => string;
  propertyEntry?: boolean;
  required?: boolean;
};

const scrubZipArchive = async (
  bytes: ArrayBuffer,
  parts: ZipPart[],
  prepare?: (
    archive: Awaited<ReturnType<typeof loadDocxArchive>>,
  ) => Promise<void>,
): Promise<ScrubDocumentPropertiesResult> => {
  const archive = await loadDocxArchive(bytes);
  if (isSignedZipArchive(archive)) {
    return { status: "signed" };
  }
  // Read every part first, then write: the reads are independent, and writing
  // into the archive while another read is in flight would race the same zip.
  const read = await Promise.all(
    parts.map(async (part) => ({
      part,
      xml: part.propertyEntry
        ? await readPropertyEntry(archive, part.path)
        : await archive.readEntryString(part.path),
    })),
  );
  for (const { part, xml } of read) {
    if (xml === null) {
      if (part.required === true) {
        return { status: "unreadable" };
      }
      continue;
    }
    archive.zip.file(part.path, part.clear(xml));
  }
  await prepare?.(archive);
  return {
    status: "scrubbed",
    bytes: await archive.zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    }),
  };
};

const STELLA_CUSTOM_PROPERTY_NAMES = new Set(["stella-ref", "stella-code"]);
const CUSTOM_PROPERTY_NAME_RE = /\bname\s*=\s*["'](?<name>[^"']*)["']/u;

const scrubCustomProperties = (xml: string): string =>
  removeNamespacedElements(
    xml,
    { namespace: OOXML_CUSTOM_NS, localName: "property" },
    (element) => {
      const name = CUSTOM_PROPERTY_NAME_RE.exec(element)?.groups?.["name"];
      return name !== undefined && STELLA_CUSTOM_PROPERTY_NAMES.has(name);
    },
  );

const ANONYMIZED_COLLABORATION_AUTHOR = "Author";
const ANONYMIZED_COLLABORATION_INITIALS = "A";

type CollaborationAttributePolicies = {
  author: {
    replacement: typeof ANONYMIZED_COLLABORATION_AUTHOR;
    type: "replace";
  };
  date: { type: "remove" };
  initials: {
    replacement: typeof ANONYMIZED_COLLABORATION_INITIALS;
    type: "replace";
  };
  providerId: { type: "remove" };
  userId: { type: "remove" };
};

/**
 * A closed policy keeps schema-required author attributes usable while making
 * it impossible to preserve typed or optional collaboration attributes.
 */
const COLLABORATION_ATTRIBUTE_POLICIES = {
  author: { replacement: ANONYMIZED_COLLABORATION_AUTHOR, type: "replace" },
  date: { type: "remove" },
  initials: {
    replacement: ANONYMIZED_COLLABORATION_INITIALS,
    type: "replace",
  },
  userId: { type: "remove" },
  providerId: { type: "remove" },
} as const satisfies CollaborationAttributePolicies;

const removeNamespacedAttribute = (
  xml: string,
  element: XmlElement,
): string => {
  let scrubbed = xml;
  for (const name of qualifiedNames(xml, element)) {
    const regex = new RegExp(
      `\\s${name}\\s*=\\s*(?<quote>["'])[^"']*\\k<quote>`,
      "gu",
    );
    scrubbed = scrubbed.replace(regex, "");
  }
  return scrubbed;
};

type ReplaceNamespacedAttributeOptions = {
  element: XmlElement;
  replacement:
    | typeof ANONYMIZED_COLLABORATION_AUTHOR
    | typeof ANONYMIZED_COLLABORATION_INITIALS;
  xml: string;
};

const replaceNamespacedAttribute = ({
  element,
  replacement,
  xml,
}: ReplaceNamespacedAttributeOptions): string => {
  let scrubbed = xml;
  for (const name of qualifiedNames(xml, element)) {
    const regex = new RegExp(`(\\s${name}\\s*=\\s*)(["'])[^"']*\\2`, "gu");
    scrubbed = scrubbed.replace(
      regex,
      (_attribute, prefix) => `${prefix}"${replacement}"`,
    );
  }
  return scrubbed;
};

const scrubCollaborationAttributes = (xml: string): string => {
  let scrubbed = xml;
  for (const namespace of [WORD_MAIN_NS, WORD_2012_NS]) {
    for (const [localName, action] of Object.entries(
      COLLABORATION_ATTRIBUTE_POLICIES,
    )) {
      const element = { namespace, localName };
      switch (action.type) {
        case "replace":
          scrubbed = replaceNamespacedAttribute({
            element,
            replacement: action.replacement,
            xml: scrubbed,
          });
          break;
        case "remove":
          scrubbed = removeNamespacedAttribute(scrubbed, element);
          break;
        default:
          action satisfies never;
          panic(`Unhandled action: ${String(action)}`);
      }
    }
  }
  return scrubbed;
};

const scrubOoxml = async (
  bytes: ArrayBuffer,
): Promise<ScrubDocumentPropertiesResult> => {
  const archive = await loadDocxArchive(bytes);
  const collaborationParts = Object.keys(archive.zip.files)
    .filter((path) => /^word\/.*\.xml$/iu.test(path))
    .map((path) => ({ path, clear: scrubCollaborationAttributes }));
  return await scrubZipArchive(bytes, [
    {
      path: "docProps/core.xml",
      clear: (xml) => {
        if (
          !hasNamespacedElement(xml, {
            namespace: OOXML_CORE_NS,
            localName: "coreProperties",
          })
        ) {
          throw new DocumentPropertiesParseError({
            message: "Invalid OOXML core properties root",
          });
        }
        let scrubbed = clearNamespacedElements(xml, OOXML_CORE_TEXT_CLEARED);
        for (const element of OOXML_CORE_REMOVED) {
          scrubbed = removeNamespacedElements(scrubbed, element);
        }
        return scrubbed;
      },
      propertyEntry: true,
      required: true,
    },
    {
      path: "docProps/app.xml",
      clear: (xml) => {
        if (
          !hasNamespacedElement(xml, {
            namespace: OOXML_APP_NS,
            localName: "Properties",
          })
        ) {
          throw new DocumentPropertiesParseError({
            message: "Invalid OOXML extended properties root",
          });
        }
        return zeroNamespacedElement(
          clearNamespacedElements(xml, OOXML_APP_CLEARED),
          { namespace: OOXML_APP_NS, localName: "TotalTime" },
        );
      },
      propertyEntry: true,
      required: true,
    },
    {
      path: "docProps/custom.xml",
      clear: scrubCustomProperties,
      propertyEntry: true,
    },
    ...collaborationParts,
  ]);
};

const removeOdfStatisticsAndUserProperties = (xml: string): string => {
  const withoutStatistics = removeNamespacedElements(xml, {
    namespace: ODF_META_NS,
    localName: "document-statistic",
  });
  return removeNamespacedElements(withoutStatistics, {
    namespace: ODF_META_NS,
    localName: "user-defined",
  });
};

const scrubOdf = async (
  bytes: ArrayBuffer,
): Promise<ScrubDocumentPropertiesResult> =>
  await scrubZipArchive(
    bytes,
    [
      {
        path: "meta.xml",
        clear: (xml) =>
          removeOdfStatisticsAndUserProperties(
            clearNamespacedElements(xml, ODF_META_CLEARED),
          ),
        propertyEntry: true,
        required: true,
      },
    ],
    async (archive) => {
      const firstPath = Object.keys(archive.zip.files).at(0);
      const mimetype = await readPropertyEntry(archive, "mimetype");
      if (firstPath !== "mimetype" || mimetype === null) {
        throw new DocumentPropertiesParseError({
          message: "ODF mimetype must be the first ZIP entry",
        });
      }
      archive.zip.file("mimetype", mimetype, { compression: "STORE" });
    },
  );

const scrubPdf = async (
  bytes: ArrayBuffer,
  scrubbedAt: Date,
): Promise<ScrubDocumentPropertiesResult> => {
  const pdf = await PDF.load(new Uint8Array(bytes));
  if (pdf.isEncrypted) {
    return { status: "password-protected" };
  }
  if (pdf.getForm()?.properties.hasSignatures === true) {
    return { status: "signed" };
  }

  // Overwrite through the document API rather than deleting the trailer's
  // Info entry: libpdf rebuilds the trailer on save, so a raw delete is
  // discarded and the original strings survive into the exported bytes.
  // The dates cannot be unset, so they become the moment this copy was
  // produced, which is true of the copy and silent about the drafting.
  pdf.setMetadata({
    title: "",
    author: "",
    subject: "",
    keywords: [],
    creator: "",
    producer: "",
    creationDate: scrubbedAt,
    modificationDate: scrubbedAt,
  });
  // Info is only half the story. Most producers write the same author and
  // title again into an XMP packet hanging off the catalog, so clearing Info
  // alone would leave the names one `strings` invocation away.
  pdf.getCatalog().delete("Metadata");

  // A full save, never `{ incremental: true }`: an incremental update appends
  // the cleared state while the originals stay physically present earlier in
  // the file, which for a scrub is no removal at all.
  return { status: "scrubbed", bytes: await pdf.save() };
};

type ScrubDocumentPropertiesOptions = {
  bytes: ArrayBuffer;
  mimeType: string;
  /** Timestamp the cleaned copy is dated with; injected so it is testable. */
  scrubbedAt?: Date;
};

/**
 * Produce a copy of `bytes` without the metadata that identifies who drafted
 * the document, for whom, and over how long. Never throws: an unexpected
 * document shape is reported as `unreadable` so the caller refuses the export
 * rather than handing over a file it failed to clean.
 */
// ── Writing ─────────────────────────────────────────────

/**
 * Where each authored property lives in an OOXML package, mirroring the reader
 * above. Total over the authored key list, so a key added to the contract fails
 * this typecheck rather than silently becoming unwritable.
 *
 * `core` is `docProps/core.xml`, `app` is `docProps/app.xml`. The parts have
 * different namespaces and different root elements, so a property cannot simply
 * be written to whichever part happens to exist.
 */
const OOXML_AUTHORED_ELEMENT = {
  title: { part: "core", element: "dc:title" },
  subject: { part: "core", element: "dc:subject" },
  description: { part: "core", element: "dc:description" },
  keywords: { part: "core", element: "cp:keywords" },
  category: { part: "core", element: "cp:category" },
  contentStatus: { part: "core", element: "cp:contentStatus" },
  author: { part: "core", element: "dc:creator" },
  lastModifiedBy: { part: "core", element: "cp:lastModifiedBy" },
  company: { part: "app", element: "Company" },
  manager: { part: "app", element: "Manager" },
} as const satisfies Record<
  AuthoredDocumentPropertyKey,
  { part: "core" | "app"; element: string }
>;

const OOXML_PART_PATH = {
  core: "docProps/core.xml",
  app: "docProps/app.xml",
} as const;

/** Root element of each part, used to append a property the file never had. */
const OOXML_PART_ROOT = {
  core: "cp:coreProperties",
  app: "Properties",
} as const;

const OOXML_PART_ROOT_NAMESPACE = {
  core: { namespace: OOXML_CORE_NS, localName: "coreProperties" },
  app: { namespace: OOXML_APP_NS, localName: "Properties" },
} as const satisfies Record<"core" | "app", XmlElement>;

/**
 * A package may carry no `docProps` at all — plenty of generators emit none —
 * and then there is no element to edit and nothing to append to. Creating the
 * part is not enough on its own: a part that is not declared in
 * `[Content_Types].xml` and not related from `_rels/.rels` is invisible to
 * Word, so all three go together or the edit is written into a void.
 */
const OOXML_EMPTY_PART = {
  core:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
    ' xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>',
  app:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>',
} as const;

const OOXML_PART_CONTENT_TYPE = {
  core: "application/vnd.openxmlformats-package.core-properties+xml",
  app: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
} as const;

const OOXML_PART_RELATIONSHIP_TYPE = {
  core: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  app: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
} as const;

const CONTENT_TYPES_PATH = "[Content_Types].xml";
const PACKAGE_RELS_PATH = "_rels/.rels";

/** Lowest relationship number not already taken. */
const nextRelationshipId = (taken: ReadonlySet<number>): number => {
  let candidate = 1;
  while (taken.has(candidate)) {
    candidate++;
  }
  return candidate;
};

type OoxmlPart = keyof typeof OOXML_PART_PATH;

/**
 * Declare freshly created parts in the package, so a reader can find them.
 * Takes every part at once: both manifests are rewritten in a single pass, so
 * the relationship ids cannot collide with each other.
 *
 * Returns false when either manifest is missing or malformed, which means the
 * caller must not claim the properties were written.
 */
const declareOoxmlParts = async (
  archive: Awaited<ReturnType<typeof loadDocxArchive>>,
  parts: readonly OoxmlPart[],
): Promise<boolean> => {
  const [contentTypes, rels] = await Promise.all([
    archive.readEntryString(CONTENT_TYPES_PATH),
    archive.readEntryString(PACKAGE_RELS_PATH),
  ]);
  if (contentTypes === null || rels === null) {
    return false;
  }
  if (!/<\/Types>/u.test(contentTypes) || !/<\/Relationships>/u.test(rels)) {
    return false;
  }

  const overrides = parts
    .map(
      (part) =>
        `<Override PartName="/${OOXML_PART_PATH[part]}" ContentType="${OOXML_PART_CONTENT_TYPE[part]}"/>`,
    )
    .join("");

  const taken = new Set(
    [...rels.matchAll(/Id="rId(?<id>\d+)"/gu)].flatMap((match) => {
      const id = Number(match.groups?.["id"]);
      return Number.isInteger(id) ? [id] : [];
    }),
  );
  const relationships = parts
    .map((part) => {
      const id = nextRelationshipId(taken);
      taken.add(id);
      return `<Relationship Id="rId${String(id)}" Type="${OOXML_PART_RELATIONSHIP_TYPE[part]}" Target="${OOXML_PART_PATH[part]}"/>`;
    })
    .join("");

  archive.zip.file(
    CONTENT_TYPES_PATH,
    contentTypes.replace(/<\/Types>/u, () => `${overrides}</Types>`),
  );
  archive.zip.file(
    PACKAGE_RELS_PATH,
    rels.replace(
      /<\/Relationships>/u,
      () => `${relationships}</Relationships>`,
    ),
  );
  return true;
};

const escapeXmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

// XML 1.0 permits tab, LF and CR from the C0 range and nothing else.
// oxlint-disable-next-line no-control-regex -- XML defines this codepoint set
const XML_1_FORBIDDEN_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;

/**
 * Set `<name>` to `value`, replacing its content in place. A property the
 * document never carried has no element to replace, so append one before the
 * closing root tag rather than dropping the edit silently.
 */
const setElement = (xml: string, name: string, value: string, root: string) => {
  // Every replacement below is a function, not a string: the value is written
  // by a person, and `$&` or `$'` in a replacement string is interpreted by JS
  // even when the search is a plain string, which would splice surrounding
  // markup into the property.
  const text = escapeXmlText(value);
  const existing = new RegExp(
    `(<${name}(?:\\s[^>]*)?>)[\\s\\S]*?(</${name}>)`,
    "u",
  );
  if (existing.test(xml)) {
    return xml.replace(
      existing,
      (_match, open: string, close: string) => `${open}${text}${close}`,
    );
  }
  // Self-closing form, which is how an empty property is often written.
  const selfClosing = new RegExp(`<${name}(?:\\s[^>]*)?/>`, "u");
  if (selfClosing.test(xml)) {
    return xml.replace(selfClosing, () => `<${name}>${text}</${name}>`);
  }
  const closingRoot = new RegExp(`</${root}>`, "u");
  if (!closingRoot.test(xml)) {
    return xml;
  }
  return xml.replace(closingRoot, () => `<${name}>${text}</${name}></${root}>`);
};

export type WriteDocumentPropertiesOptions = {
  bytes: ArrayBuffer;
  mimeType: string;
  /** Authored properties to set. A blank value empties the element. */
  values: Partial<Record<AuthoredDocumentPropertyKey, string>>;
};

export type WriteDocumentPropertiesResult =
  | { status: "written"; bytes: Uint8Array }
  | { status: "unsupported-format" }
  | { status: "unreadable" };

/**
 * Write authored properties back into the document's own bytes.
 *
 * OOXML only. ODF and PDF are read and scrubbed but not written: PDF carries
 * the same fields in both the Info dictionary and an XMP packet, and writing
 * one without the other leaves a file that reports two different authors
 * depending on which the reader trusts. Refusing is honest; a half-written PDF
 * is not.
 */
export const writeDocumentProperties = async ({
  bytes,
  mimeType,
  values,
}: WriteDocumentPropertiesOptions): Promise<WriteDocumentPropertiesResult> => {
  if (documentContainerFormat(mimeType) !== "ooxml") {
    return { status: "unsupported-format" };
  }

  if (
    Object.values(values).some((value) =>
      XML_1_FORBIDDEN_CONTROL_RE.test(value),
    )
  ) {
    return { status: "unreadable" };
  }

  // Driven by the contract's key list rather than the caller's object keys, so
  // an unknown key cannot reach the archive and no cast is needed to narrow it.
  const edits = AUTHORED_DOCUMENT_PROPERTY_KEYS.flatMap((key) => {
    const value = values[key];
    return value === undefined
      ? []
      : [{ ...OOXML_AUTHORED_ELEMENT[key], value }];
  });
  if (edits.length === 0) {
    return { status: "written", bytes: new Uint8Array(bytes) };
  }

  const parts = (["core", "app"] as const).filter((part) =>
    edits.some((edit) => edit.part === part),
  );

  try {
    const archive = await loadDocxArchive(bytes);
    // Read every part first, then write, matching the scrubber: the reads are
    // independent, and writing into the archive while another read is in flight
    // would race the same zip.
    const read = await Promise.all(
      parts.map(async (part) => ({
        part,
        xml: await archive.readEntryString(OOXML_PART_PATH[part]),
      })),
    );
    // Declared before anything is written: skipping a missing part instead
    // would report a successful write that changed nothing, which is how a
    // document carrying no docProps silently swallowed every edit.
    const missing = read
      .filter(({ xml }) => xml === null)
      .map(({ part }) => part);
    if (missing.length > 0 && !(await declareOoxmlParts(archive, missing))) {
      return { status: "unreadable" };
    }

    for (const { part, xml } of read) {
      let updated = xml ?? OOXML_EMPTY_PART[part];
      if (!hasNamespacedElement(updated, OOXML_PART_ROOT_NAMESPACE[part])) {
        return { status: "unreadable" };
      }
      for (const edit of edits) {
        if (edit.part === part) {
          updated = setElement(
            updated,
            edit.element,
            edit.value,
            OOXML_PART_ROOT[part],
          );
        }
      }
      archive.zip.file(OOXML_PART_PATH[part], updated);
    }
    return {
      status: "written",
      bytes: await archive.zip.generateAsync({ type: "uint8array" }),
    };
  } catch {
    return { status: "unreadable" };
  }
};

export const scrubDocumentProperties = async ({
  bytes,
  mimeType,
  scrubbedAt = new Date(),
}: ScrubDocumentPropertiesOptions): Promise<ScrubDocumentPropertiesResult> => {
  const format = documentContainerFormat(mimeType);
  if (format === null) {
    return { status: "unsupported-format" };
  }

  try {
    switch (format) {
      case "ooxml":
        return await scrubOoxml(bytes);
      case "odf":
        return await scrubOdf(bytes);
      case "pdf":
        return await scrubPdf(bytes, scrubbedAt);
      default:
        format satisfies never;
        return panic(`Unhandled format: ${String(format)}`);
    }
  } catch {
    return { status: "unreadable" };
  }
};
