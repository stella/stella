/**
 * Read a stella document reference back out of a DOCX the user is handing us.
 *
 * A document that left stella carries its reference in the OOXML custom
 * properties (`docProps/custom.xml`): `stella-code` holds the verification
 * code the API resolves, `stella-ref` the human-readable reference
 * (`2026/001/015.v3`). Reading it in the browser is what lets an upload offer
 * "file this as the next version" instead of silently creating a duplicate —
 * and it costs one small archive entry rather than re-uploading the whole file
 * to the API to ask.
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
 * The alphabet the API mints verification codes from (lowercase alphanumeric
 * minus the look-alikes 0/O/1/l/I). Validating here only avoids a request that
 * `GET /verify/:code` would reject on its own `params` pattern; the server
 * stays the authority on what resolves.
 */
const VERIFICATION_CODE_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/u;

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
 */
export const readDocumentReference = async (
  file: File,
): Promise<DocumentReference | null> => {
  if (!couldCarryDocumentReference(file)) {
    return null;
  }

  const customXml = await readCustomPropertiesXml(file);
  if (customXml === null) {
    return null;
  }

  const verificationCode = parseProperty(customXml, CODE_PROPERTY_RE);
  if (verificationCode === null) {
    return null;
  }
  if (!VERIFICATION_CODE_RE.test(verificationCode)) {
    return null;
  }

  return {
    verificationCode,
    stamp: parseProperty(customXml, STAMP_PROPERTY_RE),
  };
};

const readCustomPropertiesXml = async (file: File): Promise<string | null> => {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = zip.file(CUSTOM_PROPERTIES_PATH);
    return entry ? await entry.async("string") : null;
  } catch {
    // Corrupt archive, non-zip bytes, or an entry that failed to inflate. An
    // unreadable file simply carries no reference.
    return null;
  }
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
