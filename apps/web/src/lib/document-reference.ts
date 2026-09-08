/**
 * Read a stella document reference back out of a DOCX the user is handing us.
 *
 * A document that left stella carries its reference in the OOXML custom
 * properties (`docProps/custom.xml`): `stella-code` holds the verification
 * code the API resolves, `stella-ref` the human-readable reference
 * (`2026/001/015.v3`), and the visible footer carries both again for a file
 * that came back without the properties part. Reading it in the browser is
 * what lets an upload offer "file this as the next version" instead of
 * silently creating a duplicate — and it costs one small archive entry rather
 * than re-uploading the whole file to the API to ask.
 *
 * Never throws: every unreadable, oversized, or unstamped file answers `null`,
 * because a file the user dropped is untrusted input and the upload has to
 * proceed regardless.
 */
import JSZip from "jszip";

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
 * The alphabet the API mints verification codes from (lowercase alphanumeric
 * minus the look-alikes 0/O/1/l/I). Validating here only avoids a request that
 * `GET /verify/:code` would reject on its own `params` pattern; the server
 * stays the authority on what resolves.
 */
const VERIFICATION_CODE_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/u;

/**
 * Whether a string has the shape of a verification code. A printed code is
 * retyped by hand, so the shape is checked before it is looked up: a segment
 * that cannot be a code gets the same answer as one that resolves to nothing.
 */
export const isVerificationCode = (code: string): boolean =>
  VERIFICATION_CODE_RE.test(code);

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

export type DocumentReference = {
  /** Resolvable against `GET /verify/:code`. */
  verificationCode: string;
  /** Human-readable reference (`2026/001/015.v3`); absent on older stamps. */
  stamp: string | null;
};

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
 * Custom properties first, the footer second, in the API's own order.
 */
export const readDocumentReference = async (
  file: File,
): Promise<DocumentReference | null> => {
  if (!couldCarryDocumentReference(file)) {
    return null;
  }

  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    return (
      (await readCustomPropertyReference(zip)) ??
      (await readFooterReference(zip))
    );
  } catch {
    // Corrupt archive, non-zip bytes, or an entry that failed to inflate. An
    // unreadable file simply carries no reference.
    return null;
  }
};

const readCustomPropertyReference = async (
  zip: JSZip,
): Promise<DocumentReference | null> => {
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

const readFooterReference = async (
  zip: JSZip,
): Promise<DocumentReference | null> => {
  const footerPaths = Object.keys(zip.files).filter((path) =>
    FOOTER_FILE_RE.test(path),
  );

  for (const path of footerPaths) {
    const entry = zip.file(path);
    if (entry === null) {
      continue;
    }
    const xml = await entry.async("string");
    if (!xml.includes(STAMP_BOOKMARK)) {
      continue;
    }
    const reference = parseFooterReference(xml);
    if (reference !== null) {
      return reference;
    }
  }

  return null;
};

/**
 * The bookmark region's `<w:t>` runs, joined: the stamper splits the line
 * across runs (the code lives inside a hyperlink) so no single run holds
 * `"2026/001/015.v3  stl:kx8mq2n4p3"`. The reference is whatever precedes the
 * code.
 */
const parseFooterReference = (xml: string): DocumentReference | null => {
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
