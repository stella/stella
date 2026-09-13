/**
 * Read a stella document reference back out of a DOCX the user is handing us.
 *
 * A document that left stella carries its reference in the OOXML custom
 * properties (`docProps/custom.xml`): `stella-code` holds the verification
 * code the API resolves, `stella-ref` the human-readable reference
 * (`2026/001/015.v3`), and the visible footer carries both again for a file
 * that came back without the properties part. Reading it in the browser is
 * what lets an upload offer "file this as the next version" instead of
 * silently creating a duplicate — and it costs a couple of small archive
 * entries rather than re-uploading the whole file to the API to ask. Which
 * carriers the file still has comes back with the reference, because a file
 * that lost the visible line is offered differently from one that kept it.
 *
 * Never throws: every unreadable, oversized, or unstamped file answers `null`,
 * because a file the user dropped is untrusted input and the upload has to
 * proceed regardless.
 */
import { Result } from "better-result";
import type JSZip from "jszip";

import { isVerificationCode } from "@stll/api-contract";

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const DOCX_EXTENSION = ".docx";

/**
 * Mirrors the API's `LIMITS.docxStampMaxBytes`. A larger file was never
 * stamped on the way out, so opening it could only ever answer `null` — at the
 * cost of inflating tens of megabytes on the main thread.
 *
 * This is also the only bound on the work: JSZip exposes no public way to cap
 * a single entry's inflation, and the server-side equivalent
 * (`docx-archive.ts`) is where a hostile archive would actually matter, since
 * a bomb opened here costs the user their own tab.
 */
const MAX_REFERENCED_DOCX_BYTES = 50 * 1024 * 1024;

const CUSTOM_PROPERTIES_PATH = "docProps/custom.xml";

/**
 * The visible footer, which the API's `parseFooterStamp` reads for the same
 * reason: the custom properties can be dropped on the way back — another
 * editor's "Save as" rewrites `docProps/custom.xml` or omits the part — while
 * the footer survives, because it is document body content.
 */
const FOOTER_FILE_RE = /^word\/footer\d+\.xml$/u;
const STAMP_BOOKMARK = "stella_dms_ref";
const STAMP_BOOKMARK_REGION_RE = new RegExp(
  `<w:bookmarkStart[^>]*w:name="${STAMP_BOOKMARK}"[\\s\\S]*?<w:bookmarkEnd[^>]*/>`,
  "u",
);
const WT_TEXT_RE = /<w:t[^>]*>(?<text>[^<]*)<\/w:t>/gu;
/** Deliberately loose: `isVerificationCode` stays the one shape check. */
const STL_CODE_RE = /stl:(?<code>[^\s<]+)/u;
const STL_PREFIX = "stl:";

/**
 * Matches the shape the API's stamper writes in `buildCustomPropertiesXml`:
 * `<property ... name="stella-ref"><vt:lpwstr>…</vt:lpwstr></property>`.
 */
const buildPropertyRegex = (name: string): RegExp =>
  new RegExp(
    `<property[^>]*name="${name}"[^>]*>\\s*<vt:lpwstr>([^<]*)</vt:lpwstr>`,
    "u",
  );

const CODE_PROPERTY_RE = buildPropertyRegex("stella-code");
const STAMP_PROPERTY_RE = buildPropertyRegex("stella-ref");

/**
 * Which of the two carriers the file still has.
 *
 * The two are not interchangeable evidence. The custom properties are hidden,
 * so they survive edits the user never sees; the footer line is visible, so
 * removing it is something the user did on purpose.
 */
export const DOCUMENT_REFERENCE_EVIDENCE = {
  /** Both carriers name the document: the file is what it says it is. */
  propertiesAndFooter: "properties-and-footer",
  /** Hidden property only: the visible line was taken out of this file. */
  propertiesOnly: "properties-only",
  /** Footer line only: another editor rewrote the properties part away. */
  footerOnly: "footer-only",
} as const;

export type DocumentReferenceEvidence =
  (typeof DOCUMENT_REFERENCE_EVIDENCE)[keyof typeof DOCUMENT_REFERENCE_EVIDENCE];

/** What a carrier holds, before the two are weighed against each other. */
type CarriedReference = {
  /** Resolvable against `GET /verify/:code`. */
  verificationCode: string;
  /** Human-readable reference (`2026/001/015.v3`); absent on older stamps. */
  stamp: string | null;
};

export type DocumentReference = CarriedReference & {
  evidence: DocumentReferenceEvidence;
};

/**
 * What a file that carries a reference is offered as.
 *
 * Shared by both dialogs that ask the question, so the two cannot drift into
 * defaulting differently on the same file.
 */
export const REFERENCE_UPLOAD_ACTION = {
  /** File it onto the document its reference names. */
  version: "version",
  /** Ignore the reference and create a separate document. */
  newDocument: "new-document",
} as const;

export type ReferenceUploadAction =
  (typeof REFERENCE_UPLOAD_ACTION)[keyof typeof REFERENCE_UPLOAD_ACTION];

/**
 * The visible line is the user's signal. A file whose hidden property still
 * names a document but whose reference line is gone was most likely reused as
 * a new document — the formatting kept, the line deleted — so it must not be
 * filed as a version of the old one on the strength of a property nobody can
 * see. Both offers stay on the dialog; only which one leads changes.
 */
const DEFAULT_ACTION_BY_EVIDENCE = {
  [DOCUMENT_REFERENCE_EVIDENCE.propertiesAndFooter]:
    REFERENCE_UPLOAD_ACTION.version,
  [DOCUMENT_REFERENCE_EVIDENCE.propertiesOnly]:
    REFERENCE_UPLOAD_ACTION.newDocument,
  [DOCUMENT_REFERENCE_EVIDENCE.footerOnly]: REFERENCE_UPLOAD_ACTION.version,
} as const satisfies Record<DocumentReferenceEvidence, ReferenceUploadAction>;

export const defaultReferenceUploadAction = (
  evidence: DocumentReferenceEvidence,
): ReferenceUploadAction => DEFAULT_ACTION_BY_EVIDENCE[evidence];

/**
 * Cheap synchronous pre-filter, so a batch of images or PDFs never pays for
 * archive inspection. Browsers report an empty `type` for files dragged out of
 * some sources, hence the extension fallback.
 */
export const couldCarryDocumentReference = (file: File): boolean => {
  if (file.size > MAX_REFERENCED_DOCX_BYTES) {
    return false;
  }
  if (file.type === DOCX_MIME_TYPE) {
    return true;
  }
  return file.type === "" && file.name.toLowerCase().endsWith(DOCX_EXTENSION);
};

/**
 * Extract the stella reference a DOCX carries, or `null` when it has none, is
 * not a DOCX, is too large to have been stamped, or cannot be opened at all.
 * Custom properties decide the reference, in the API's own order; the footer
 * is read either way, because whether the visible line survived is itself the
 * answer to what the file should be offered as.
 */
export const readDocumentReference = async (
  file: File,
): Promise<DocumentReference | null> => {
  if (!couldCarryDocumentReference(file)) {
    return null;
  }

  const result = await Result.tryPromise(async () => {
    // One archive, both carriers: the footer parts are a few kilobytes next
    // to the file the user just dropped. JSZip stays out of the protected
    // shell's eager bundle; only a qualifying DOCX pays to load it.
    const { default: ZipArchive } = await import("jszip");
    const zip = await ZipArchive.loadAsync(await file.arrayBuffer());
    const properties = await readCustomPropertyReference(zip);
    const footer = await readFooterStamp(zip);

    if (properties !== null) {
      return {
        verificationCode: properties.verificationCode,
        stamp: properties.stamp,
        evidence:
          footer.type === "absent"
            ? DOCUMENT_REFERENCE_EVIDENCE.propertiesOnly
            : DOCUMENT_REFERENCE_EVIDENCE.propertiesAndFooter,
      };
    }

    if (footer.type !== "readable") {
      return null;
    }
    return {
      verificationCode: footer.reference.verificationCode,
      stamp: footer.reference.stamp,
      evidence: DOCUMENT_REFERENCE_EVIDENCE.footerOnly,
    };
  });
  if (Result.isError(result)) {
    // Corrupt archive, non-zip bytes, or an entry that failed to inflate. An
    // unreadable file simply carries no reference.
    return null;
  }
  return result.value;
};

const readCustomPropertyReference = async (
  zip: JSZip,
): Promise<CarriedReference | null> => {
  const entry = zip.file(CUSTOM_PROPERTIES_PATH);
  if (entry === null) {
    return null;
  }

  const xml = await entry.async("string");
  const verificationCode = parseProperty(xml, CODE_PROPERTY_RE);
  if (verificationCode === null || !isVerificationCode(verificationCode)) {
    return null;
  }

  return {
    verificationCode,
    stamp: parseProperty(xml, STAMP_PROPERTY_RE),
  };
};

/**
 * A line the user edited into nonsense is still a line they kept, so "the
 * bookmark is there but its text no longer parses" is its own answer: it
 * supplies no reference, yet it is not a removed line either.
 */
type FooterStamp =
  | { type: "absent" }
  | { type: "unreadable" }
  | { type: "readable"; reference: CarriedReference };

const readFooterStamp = async (zip: JSZip): Promise<FooterStamp> => {
  const footerPaths = Object.keys(zip.files).filter((path) =>
    FOOTER_FILE_RE.test(path),
  );

  let bookmarked = false;
  for (const path of footerPaths) {
    const entry = zip.file(path);
    if (entry === null) {
      continue;
    }
    const xml = await entry.async("string");
    if (!xml.includes(STAMP_BOOKMARK)) {
      continue;
    }
    bookmarked = true;
    const reference = parseFooterReference(xml);
    if (reference !== null) {
      return { type: "readable", reference };
    }
  }

  return bookmarked ? { type: "unreadable" } : { type: "absent" };
};

/**
 * The bookmark region's `<w:t>` runs, joined: the stamper splits the line
 * across runs (the code lives inside a hyperlink) so no single run holds
 * `"2026/001/015.v3  stl:kx8mq2n4p3"`. The reference is whatever precedes the
 * code.
 */
const parseFooterReference = (xml: string): CarriedReference | null => {
  const region = STAMP_BOOKMARK_REGION_RE.exec(xml)?.[0];
  if (region === undefined) {
    return null;
  }

  const text = decodeXmlEntities(
    [...region.matchAll(WT_TEXT_RE)]
      .map((match) => match.groups?.["text"] ?? "")
      .join(""),
  ).trim();

  const verificationCode = STL_CODE_RE.exec(text)?.groups?.["code"];
  if (verificationCode === undefined || !isVerificationCode(verificationCode)) {
    return null;
  }

  const stamp = text.slice(0, text.indexOf(STL_PREFIX)).trim();
  return { verificationCode, stamp: stamp === "" ? null : stamp };
};

const parseProperty = (xml: string, pattern: RegExp): string | null => {
  const value = pattern.exec(xml)?.[1];
  if (value === undefined) {
    return null;
  }
  const decoded = decodeXmlEntities(value).trim();
  return decoded === "" ? null : decoded;
};

/** Inverse of the API stamper's `escapeXml`. */
const decodeXmlEntities = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
