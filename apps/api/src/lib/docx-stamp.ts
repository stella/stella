/**
 * DOCX document-reference injection and extraction.
 *
 * Injects a visible footer and invisible custom properties
 * into DOCX files for document provenance tracking. Uses
 * JSZip to manipulate the OOXML package; XML is handled
 * via string operations for simplicity and robustness.
 *
 * Nothing here substitutes text the author wrote. A `{{ ... }}` sequence in a
 * DOCX belongs to the docxtpl Jinja template grammar, so this module must
 * never claim a spelling inside those braces: the footer and the custom
 * properties are the only things it writes.
 */
import type { DocxArchive } from "@/api/lib/docx-archive";
import { loadDocxArchive } from "@/api/lib/docx-archive";
import { LIMITS } from "@/api/lib/limits";

const STAMP_BOOKMARK = "stella_dms_ref";
const STAMP_BOOKMARK_MARKER = `w:name="${STAMP_BOOKMARK}"`;
const STAMP_HYPERLINK_REL_ID = "rId_stella_vcode";
const STAMP_PROPERTY_NAMES = ["stella-ref", "stella-code"] as const;
const CUSTOM_PROPS_PATH = "docProps/custom.xml";
const CONTENT_TYPES_PATH = "[Content_Types].xml";
const ROOT_RELS_PATH = "_rels/.rels";
const PARAGRAPH_CLOSE = "</w:p>";

const CUSTOM_PROPS_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/" +
  "custom-properties";
const VT_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
const CUSTOM_PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.custom-properties+xml";

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CUSTOM_PROPS_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/" +
  "relationships/custom-properties";
const HYPERLINK_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/" +
  "relationships/hyperlink";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const FOOTER_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/" +
  "relationships/footer";
const FOOTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument" +
  ".wordprocessingml.footer+xml";

/** DOCX MIME types we handle. */
const DOCX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument" +
    ".wordprocessingml.document",
]);

/** OOXML custom property format identifier (fixed by spec). */
const FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";

// ── Top-level regex (oxlint: prefer-regex-literals) ───────────

const PID_RE = /pid="(?<pid>\d+)"/gu;
const WID_RE = /w:id="(?<id>\d+)"/gu;
const FOOTER_FILE_RE = /^word\/footer\d+\.xml$/u;
const WT_TEXT_RE = /<w:t[^>]*>(?<text>[^<]*)<\/w:t>/gu;
const STL_CODE_RE = /stl:(?<code>[abcdefghjkmnpqrstuvwxyz23456789]{10})/u;
const STL_SUFFIX_RE = /(?<!\s)\s*stl:[abcdefghjkmnpqrstuvwxyz23456789]+\s*$/u;
const SECT_PR_RE = /(?<sect><w:sectPr[^>]*>)/u;
const CLOSING_BODY_RE = /<\/w:body>/u;
const CLOSING_FTR_RE = /<\/w:ftr>/u;
const STRIP_PATH_RE = /^.*\//u;
const FOOTER_REL_RE =
  /Id="(?<id>[^"]+)"[^>]*Type="[^"]*\/footer"[^>]*Target="(?<target>[^"]+)"/gu;
const DEFAULT_FOOTER_REF_RE =
  /w:footerReference[^>]*w:type="default"[^>]*r:id="(?<rid>[^"]+)"/u;
const PARAGRAPH_OPEN_RE = /<w:p(?:\s[^>]*)?>/gu;
const ANY_PROPERTY_RE = /<property[\s>]/u;
const ANY_PARAGRAPH_RE = /<w:p[\s/>]/u;
/**
 * The footer line exactly as {@link buildStampParagraph} writes it: the
 * reference, two spaces, then `stl:` and a verification code. The reference is
 * a free-form matter reference, so only its surroundings can be pinned. Any
 * other text means a human edited the line, and stripping then removes their
 * words rather than ours.
 */
const STAMP_TEXT_RE =
  /^\S(?:.*\S)? {2}stl:[abcdefghjkmnpqrstuvwxyz23456789]{10}$/u;

// ── Public API ──────────────────────────────────────────

export const isStampableDocx = (mimeType: string, sizeBytes: number): boolean =>
  DOCX_MIME_TYPES.has(mimeType) && sizeBytes <= LIMITS.docxStampMaxBytes;

/**
 * Inject the document reference into a DOCX file. Adds:
 * 1. Custom properties (stella-ref, stella-code)
 * 2. A visible right-aligned footer
 *
 * Only called when the user explicitly requests the reference.
 * Idempotent: an existing stella reference is updated, not duplicated.
 */
export const injectStamp = async (
  docxBuffer: ArrayBuffer,
  stamp: string,
  verificationCode: string,
  baseUrl: string,
): Promise<ArrayBuffer> => {
  let archive: DocxArchive;
  try {
    archive = await loadDocxArchive(docxBuffer);
  } catch {
    // Corrupt or non-DOCX buffer; return original unchanged
    return docxBuffer;
  }

  await injectCustomProperties(archive, stamp, verificationCode);
  await injectFooter(archive, stamp, verificationCode, baseUrl);

  return archive.zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  });
};

/**
 * Extract Stella stamp metadata from a DOCX file.
 * Checks custom properties first (reliable), then falls
 * back to footer bookmark parsing.
 */
export const extractStamp = async (
  docxBuffer: ArrayBuffer,
): Promise<{
  verificationCode: string | null;
  stamp: string | null;
}> => {
  let archive: DocxArchive;
  try {
    archive = await loadDocxArchive(docxBuffer);
  } catch {
    // Malformed or corrupt DOCX; treat as no stamp
    return { verificationCode: null, stamp: null };
  }

  // 1. Try custom properties (fast, reliable)
  const customXml = await archive.readEntryString(CUSTOM_PROPS_PATH);

  if (customXml) {
    const code = parseCustomProperty(customXml, "stella-code");
    const ref = parseCustomProperty(customXml, "stella-ref");
    if (code || ref) {
      return { verificationCode: code, stamp: ref };
    }
  }

  // 2. Fallback: parse footer for bookmark
  return parseFooterStamp(archive);
};

/**
 * Remove the document reference from a DOCX.
 *
 * The reference belongs on the way out, not in storage: it names one version,
 * so bytes stored with it would carry the previous version's code forever, and
 * a stamped download re-uploaded as a new document would keep resolving to the
 * document it came from. Every path that stores document bytes runs this first
 * (see `lib/files/stored-document-bytes.ts`).
 *
 * Returns null when the file carried nothing, so an unstamped upload keeps its
 * exact bytes and hash; the rewritten archive otherwise. A corrupt archive
 * yields null rather than an error: the scan and DOCX validation steps own that
 * verdict, and this one must not turn their input away first.
 */
export const stripStamp = async (
  docxBuffer: ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer | null> => {
  let archive: DocxArchive;
  try {
    archive = await loadDocxArchive(docxBuffer);
  } catch {
    return null;
  }

  try {
    const strippedProperties = await stripCustomProperties(archive);
    const strippedFooter = await stripStampParagraph(archive);
    if (!strippedProperties && !strippedFooter) {
      return null;
    }
  } catch {
    // A bounded-read cap tripped part-way through: the archive is out of
    // bounds, so leave it to the validation step that reports that.
    return null;
  }

  return archive.zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  });
};

// ── Reference Removal ───────────────────────────────────

/**
 * Drop `<tagName ... marker ... />`. Attribute values in an OOXML part are
 * quoted and cannot contain `>`, so the first `>` after the marker closes the
 * element carrying it.
 */
const removeSelfClosingElement = (
  xml: string,
  tagName: string,
  marker: string,
): string => {
  const markerIndex = xml.indexOf(marker);
  if (markerIndex === -1) {
    return xml;
  }
  const start = xml.lastIndexOf(`<${tagName}`, markerIndex);
  const end = xml.indexOf(">", markerIndex);
  if (start === -1 || end === -1) {
    return xml;
  }
  return xml.slice(0, start) + xml.slice(end + 1);
};

/** Drop `<tagName ... marker ...>…</tagName>`. */
const removePairedElement = (
  xml: string,
  tagName: string,
  marker: string,
): string => {
  const markerIndex = xml.indexOf(marker);
  if (markerIndex === -1) {
    return xml;
  }
  const closing = `</${tagName}>`;
  const start = xml.lastIndexOf(`<${tagName}`, markerIndex);
  const end = xml.indexOf(closing, markerIndex);
  if (start === -1 || end === -1) {
    return xml;
  }
  return xml.slice(0, start) + xml.slice(end + closing.length);
};

const removePartDeclaration = async (
  archive: DocxArchive,
  path: string,
  tagName: string,
  marker: string,
): Promise<void> => {
  const xml = await archive.readEntryString(path);
  if (!xml) {
    return;
  }
  const stripped = removeSelfClosingElement(xml, tagName, marker);
  if (stripped !== xml) {
    archive.zip.file(path, stripped);
  }
};

/**
 * Remove the two stella custom properties and leave any the author set. When
 * they were the only ones the part goes too, along with its content-type
 * override and package relationship: Word refuses a package that declares a
 * part it does not contain.
 */
const stripCustomProperties = async (
  archive: DocxArchive,
): Promise<boolean> => {
  const customXml = await archive.readEntryString(CUSTOM_PROPS_PATH);
  if (!customXml) {
    return false;
  }

  let stripped = customXml;
  for (const name of STAMP_PROPERTY_NAMES) {
    stripped = removePairedElement(stripped, "property", `name="${name}"`);
  }
  if (stripped === customXml) {
    return false;
  }

  if (ANY_PROPERTY_RE.test(stripped)) {
    archive.zip.file(CUSTOM_PROPS_PATH, stripped);
    return true;
  }

  archive.zip.remove(CUSTOM_PROPS_PATH);
  await removePartDeclaration(
    archive,
    CONTENT_TYPES_PATH,
    "Override",
    `PartName="/${CUSTOM_PROPS_PATH}"`,
  );
  await removePartDeclaration(
    archive,
    ROOT_RELS_PATH,
    "Relationship",
    `Target="${CUSTOM_PROPS_PATH}"`,
  );
  return true;
};

/**
 * The bookmarked paragraph's span. The opening tag comes from scanning the
 * paragraph starts before the bookmark rather than searching backwards for the
 * literal `<w:p`, which `<w:pPr>` also matches.
 */
const stampParagraphRange = (
  footerXml: string,
): { start: number; end: number } | null => {
  const bookmarkIndex = footerXml.indexOf(STAMP_BOOKMARK_MARKER);
  if (bookmarkIndex === -1) {
    return null;
  }

  let start = -1;
  for (const match of footerXml.matchAll(PARAGRAPH_OPEN_RE)) {
    if (match.index >= bookmarkIndex) {
      break;
    }
    start = match.index;
  }

  const closeIndex = footerXml.indexOf(PARAGRAPH_CLOSE, bookmarkIndex);
  if (start === -1 || closeIndex === -1) {
    return null;
  }
  return { start, end: closeIndex + PARAGRAPH_CLOSE.length };
};

/** A footer Word writes always holds a paragraph; keep one when ours was the last. */
const keepFooterBlockContent = (footerXml: string): string =>
  ANY_PARAGRAPH_RE.test(footerXml)
    ? footerXml
    : footerXml.replace(CLOSING_FTR_RE, () => "<w:p/>\n</w:ftr>");

const footerRelsPathFor = (footerPath: string): string =>
  `word/_rels/${footerPath.replace(STRIP_PATH_RE, () => "")}.rels`;

/**
 * Remove the footer line and its verification hyperlink, but only where the
 * text still reads exactly as stella wrote it. An edited line keeps its
 * bookmark: the words are the author's by then, and the next stamped download
 * rewrites that paragraph in place anyway.
 */
const stripStampParagraph = async (archive: DocxArchive): Promise<boolean> => {
  const footerPaths = Object.keys(archive.zip.files).filter((path) =>
    FOOTER_FILE_RE.test(path),
  );

  let stripped = false;
  for (const path of footerPaths) {
    const footerXml = await archive.readEntryString(path);
    if (!footerXml?.includes(STAMP_BOOKMARK)) {
      continue;
    }
    const range = stampParagraphRange(footerXml);
    if (!range) {
      continue;
    }
    if (
      !STAMP_TEXT_RE.test(
        collectRunText(footerXml.slice(range.start, range.end)),
      )
    ) {
      continue;
    }

    archive.zip.file(
      path,
      keepFooterBlockContent(
        footerXml.slice(0, range.start) + footerXml.slice(range.end),
      ),
    );
    await removePartDeclaration(
      archive,
      footerRelsPathFor(path),
      "Relationship",
      `Id="${STAMP_HYPERLINK_REL_ID}"`,
    );
    stripped = true;
  }

  return stripped;
};

// ── Custom Properties ───────────────────────────────────

const injectCustomProperties = async (
  archive: DocxArchive,
  stamp: string,
  verificationCode: string,
): Promise<void> => {
  const existingXml = await archive.readEntryString(CUSTOM_PROPS_PATH);

  if (existingXml) {
    archive.zip.file(
      CUSTOM_PROPS_PATH,
      updateCustomProperties(existingXml, stamp, verificationCode),
    );
    return;
  }

  // Create new custom.xml
  archive.zip.file(
    CUSTOM_PROPS_PATH,
    buildCustomPropertiesXml(stamp, verificationCode),
  );

  // Ensure Content_Types includes custom properties
  await ensureContentType(archive);

  // Ensure .rels includes custom properties relationship
  await ensureCustomPropsRelationship(archive);
};

const buildCustomPropertiesXml = (
  stamp: string,
  verificationCode: string,
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Properties xmlns="${CUSTOM_PROPS_NS}"`,
    `            xmlns:vt="${VT_NS}">`,
    `  <property fmtid="${FMTID}" pid="2"`,
    '            name="stella-ref">',
    `    <vt:lpwstr>${escapeXml(stamp)}</vt:lpwstr>`,
    "  </property>",
    `  <property fmtid="${FMTID}" pid="3"`,
    '            name="stella-code">',
    `    <vt:lpwstr>${escapeXml(verificationCode)}</vt:lpwstr>`,
    "  </property>",
    "</Properties>",
  ].join("\n");

/**
 * Update existing custom.xml: replace stella-ref and
 * stella-code values, or append them if missing.
 */
const updateCustomProperties = (
  xml: string,
  stamp: string,
  verificationCode: string,
): string => {
  let result = xml;
  result = upsertProperty(result, "stella-ref", stamp);
  result = upsertProperty(result, "stella-code", verificationCode);
  return result;
};

const upsertProperty = (xml: string, name: string, value: string): string => {
  // Try to replace existing value
  const re = new RegExp(
    `(<property[^>]*name="${name}"[^>]*>` +
      "\\s*<vt:lpwstr>)[^<]*(</vt:lpwstr>\\s*</property>)",
    "u",
  );
  if (re.test(xml)) {
    return xml.replace(
      re,
      (_match, open: string, close: string) =>
        `${open}${escapeXml(value)}${close}`,
    );
  }

  // Find max pid for new property
  const pidMatches = [...xml.matchAll(PID_RE)];
  let maxPid = 1;
  for (const match of pidMatches) {
    maxPid = Math.max(
      maxPid,
      Number.parseInt(match.groups?.["pid"] ?? "0", 10),
    );
  }
  const prop = [
    `  <property fmtid="${FMTID}" pid="${maxPid + 1}"`,
    `            name="${name}">`,
    `    <vt:lpwstr>${escapeXml(value)}</vt:lpwstr>`,
    "  </property>",
  ].join("\n");

  return xml.replace("</Properties>", () => `${prop}\n</Properties>`);
};

const ensureContentType = async (archive: DocxArchive): Promise<void> => {
  const ct = await archive.readEntryString(CONTENT_TYPES_PATH);
  if (!ct || ct.includes(CUSTOM_PROPS_PATH)) {
    return;
  }

  const override =
    `<Override PartName="/${CUSTOM_PROPS_PATH}"` +
    ` ContentType="${CUSTOM_PROPS_CONTENT_TYPE}"/>`;
  archive.zip.file(
    CONTENT_TYPES_PATH,
    ct.replace("</Types>", () => `${override}\n</Types>`),
  );
};

const ensureCustomPropsRelationship = async (
  archive: DocxArchive,
): Promise<void> => {
  const relsPath = "_rels/.rels";
  const rels = await archive.readEntryString(relsPath);

  if (!rels) {
    archive.zip.file(
      relsPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Relationships xmlns="${REL_NS}">`,
        '  <Relationship Id="rIdCustomProps"',
        `    Type="${CUSTOM_PROPS_REL_TYPE}"`,
        `    Target="${CUSTOM_PROPS_PATH}"/>`,
        "</Relationships>",
      ].join("\n"),
    );
    return;
  }

  if (rels.includes(CUSTOM_PROPS_REL_TYPE)) {
    return;
  }

  const rel =
    '"rIdCustomProps"' +
    ` Type="${CUSTOM_PROPS_REL_TYPE}"` +
    ` Target="${CUSTOM_PROPS_PATH}"/>`;
  archive.zip.file(
    relsPath,
    rels.replace(
      "</Relationships>",
      () => `<Relationship Id=${rel}\n</Relationships>`,
    ),
  );
};

// ── Footer Injection ────────────────────────────────────

const buildStampParagraph = (
  stamp: string,
  verificationCode: string,
  hyperlinkRId: string,
  bookmarkId: string,
): string =>
  [
    "<w:p>",
    '  <w:pPr><w:jc w:val="right"/></w:pPr>',
    `  <w:bookmarkStart w:id="${bookmarkId}"`,
    `    w:name="${STAMP_BOOKMARK}"/>`,
    "  <w:r>",
    "    <w:rPr>",
    '      <w:color w:val="999999"/>',
    '      <w:sz w:val="14"/>',
    '      <w:szCs w:val="14"/>',
    "    </w:rPr>",
    `    <w:t xml:space="preserve">${escapeXml(stamp)}  </w:t>`,
    "  </w:r>",
    `  <w:hyperlink r:id="${hyperlinkRId}">`,
    "    <w:r>",
    "      <w:rPr>",
    '        <w:color w:val="999999"/>',
    '        <w:sz w:val="14"/>',
    '        <w:szCs w:val="14"/>',
    "      </w:rPr>",
    `      <w:t>stl:${escapeXml(verificationCode)}</w:t>`,
    "    </w:r>",
    "  </w:hyperlink>",
    `  <w:bookmarkEnd w:id="${bookmarkId}"/>`,
    "</w:p>",
  ].join("\n");

const injectFooter = async (
  archive: DocxArchive,
  stamp: string,
  verificationCode: string,
  baseUrl: string,
): Promise<void> => {
  const docXml = await archive.readEntryString("word/document.xml");
  if (!docXml) {
    return;
  }

  const docRelsPath = "word/_rels/document.xml.rels";
  const docRels = (await archive.readEntryString(docRelsPath)) ?? "";

  const verifyUrl = `${baseUrl}/v/${verificationCode}`;
  const footerMatch = findExistingFooter(docXml, docRels);

  if (footerMatch) {
    await updateExistingFooter(
      archive,
      footerMatch.path,
      footerMatch.relsPath,
      stamp,
      verificationCode,
      verifyUrl,
    );
  } else {
    await createNewFooter(
      archive,
      docXml,
      docRelsPath,
      docRels,
      stamp,
      verificationCode,
      verifyUrl,
    );
  }
};

type FooterMatch = {
  path: string;
  relsPath: string;
};

/**
 * Find the existing default footer in the document.
 * Prefers the footer referenced by `w:type="default"` in
 * document.xml; falls back to the first footer relationship.
 */
const findExistingFooter = (
  docXml: string,
  docRels: string,
): FooterMatch | null => {
  // Build a map of relationship ID → target path
  const relMap = new Map<string, string>();
  for (const m of docRels.matchAll(FOOTER_REL_RE)) {
    const id = m.groups?.["id"];
    const target = m.groups?.["target"];
    if (id && target) {
      relMap.set(id, target);
    }
  }

  if (relMap.size === 0) {
    return null;
  }

  // Prefer the default footer reference from document.xml
  const defaultRef = DEFAULT_FOOTER_REF_RE.exec(docXml);
  const rId = defaultRef?.groups?.["rid"];
  const target = (rId ? relMap.get(rId) : null) ?? relMap.values().next().value;

  if (!target) {
    return null;
  }

  const path = target.startsWith("word/") ? target : `word/${target}`;
  const fileName = target.replace(STRIP_PATH_RE, "");
  const relsPath = `word/_rels/${fileName}.rels`;

  return { path, relsPath };
};

const updateExistingFooter = async (
  archive: DocxArchive,
  footerPath: string,
  footerRelsPath: string,
  stamp: string,
  verificationCode: string,
  verifyUrl: string,
): Promise<void> => {
  const footerXml = (await archive.readEntryString(footerPath)) ?? "";
  const footerRels = (await archive.readEntryString(footerRelsPath)) ?? "";

  const hyperlinkRId = STAMP_HYPERLINK_REL_ID;

  // Ensure hyperlink relationship exists
  archive.zip.file(
    footerRelsPath,
    ensureHyperlinkRel(footerRels, hyperlinkRId, verifyUrl),
  );

  if (footerXml.includes(STAMP_BOOKMARK)) {
    // Replace existing stamp paragraph
    archive.zip.file(
      footerPath,
      replaceStampParagraph(footerXml, stamp, verificationCode, hyperlinkRId),
    );
  } else {
    // Append stamp paragraph before </w:ftr>
    const bookmarkId = findNextBookmarkId(footerXml);
    const stampPara = buildStampParagraph(
      stamp,
      verificationCode,
      hyperlinkRId,
      bookmarkId,
    );
    archive.zip.file(
      footerPath,
      footerXml.replace(CLOSING_FTR_RE, () => `${stampPara}\n</w:ftr>`),
    );
  }
};

const createNewFooter = async (
  archive: DocxArchive,
  docXml: string,
  docRelsPath: string,
  docRels: string,
  stamp: string,
  verificationCode: string,
  verifyUrl: string,
): Promise<void> => {
  const footerFileName = findAvailableFooterName(archive);
  const footerPath = `word/${footerFileName}`;
  const footerRelsPath = `word/_rels/${footerFileName}.rels`;
  const footerRId = "rId_stella_footer";
  const hyperlinkRId = STAMP_HYPERLINK_REL_ID;

  // Derive bookmark ID from the document body to avoid
  // collisions with existing w:id values across the package
  const bookmarkId = findNextBookmarkId(docXml);
  const body = buildStampParagraph(
    stamp,
    verificationCode,
    hyperlinkRId,
    bookmarkId,
  );
  const footerXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}">`,
    body,
    "</w:ftr>",
  ].join("\n");
  archive.zip.file(footerPath, footerXml);

  // Create footer rels with hyperlink
  archive.zip.file(
    footerRelsPath,
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<Relationships xmlns="${REL_NS}">`,
      `  <Relationship Id="${hyperlinkRId}"`,
      `    Type="${HYPERLINK_REL_TYPE}"`,
      `    Target="${escapeXml(verifyUrl)}"`,
      '    TargetMode="External"/>',
      "</Relationships>",
    ].join("\n"),
  );

  // Add footer relationship to document.xml.rels
  const footerRel =
    `<Relationship Id="${footerRId}"` +
    ` Type="${FOOTER_REL_TYPE}"` +
    ` Target="${footerFileName}"/>`;

  if (docRels) {
    archive.zip.file(
      docRelsPath,
      docRels.replace(
        "</Relationships>",
        () => `${footerRel}\n</Relationships>`,
      ),
    );
  } else {
    archive.zip.file(
      docRelsPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Relationships xmlns="${REL_NS}">`,
        `  ${footerRel}`,
        "</Relationships>",
      ].join("\n"),
    );
  }

  // Reference footer in document.xml section properties
  archive.zip.file("word/document.xml", addFooterReference(docXml, footerRId));

  // Ensure Content_Types knows about the footer
  await ensureFooterContentType(archive, footerFileName);
};

// ── Footer Helpers ──────────────────────────────────────

const findAvailableFooterName = (archive: DocxArchive): string => {
  let n = 1;
  while (archive.zip.file(`word/footer${n}.xml`)) {
    n++;
  }
  return `footer${n}.xml`;
};

const findNextBookmarkId = (xml: string): string => {
  const ids = [...xml.matchAll(WID_RE)].map((m) =>
    Number.parseInt(m.groups?.["id"] ?? "0", 10),
  );
  const max = ids.length > 0 ? Math.max(...ids) : -1;
  return String(max + 1);
};

const replaceStampParagraph = (
  footerXml: string,
  stamp: string,
  verificationCode: string,
  hyperlinkRId: string,
): string => {
  const bookmarkId = findNextBookmarkId(footerXml);
  const newPara = buildStampParagraph(
    stamp,
    verificationCode,
    hyperlinkRId,
    bookmarkId,
  );

  // Match the entire paragraph containing the bookmark
  const re = new RegExp(
    `<w:p>[\\s\\S]*?w:name="${STAMP_BOOKMARK}"[\\s\\S]*?</w:p>`,
    "u",
  );

  if (re.test(footerXml)) {
    return footerXml.replace(re, () => newPara);
  }

  // Fallback: append
  return footerXml.replace(CLOSING_FTR_RE, () => `${newPara}\n</w:ftr>`);
};

const ensureHyperlinkRel = (rels: string, rId: string, url: string): string => {
  if (!rels) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<Relationships xmlns="${REL_NS}">`,
      `  <Relationship Id="${rId}"`,
      `    Type="${HYPERLINK_REL_TYPE}"`,
      `    Target="${escapeXml(url)}"`,
      '    TargetMode="External"/>',
      "</Relationships>",
    ].join("\n");
  }

  // Update existing stella hyperlink target
  const existingRe = new RegExp(
    `(<Relationship Id="${rId}"[^>]*Target=")[^"]*("[^>]*/>)`,
    "u",
  );
  if (existingRe.test(rels)) {
    return rels.replace(
      existingRe,
      (_match, open: string, close: string) =>
        `${open}${escapeXml(url)}${close}`,
    );
  }

  // Add new relationship
  const rel =
    `<Relationship Id="${rId}"` +
    ` Type="${HYPERLINK_REL_TYPE}"` +
    ` Target="${escapeXml(url)}"` +
    ' TargetMode="External"/>';
  return rels.replace("</Relationships>", () => `${rel}\n</Relationships>`);
};

const addFooterReference = (docXml: string, footerRId: string): string => {
  const footerRef = `<w:footerReference w:type="default" r:id="${footerRId}"/>`;

  // If there's already a sectPr, add footer reference inside
  if (docXml.includes("<w:sectPr")) {
    return docXml.replace(SECT_PR_RE, (match) => `${match}\n    ${footerRef}`);
  }

  // No sectPr: create one before </w:body>
  return docXml.replace(
    CLOSING_BODY_RE,
    () => `<w:sectPr>${footerRef}</w:sectPr>\n</w:body>`,
  );
};

const ensureFooterContentType = async (
  archive: DocxArchive,
  footerFileName: string,
): Promise<void> => {
  const ct = await archive.readEntryString(CONTENT_TYPES_PATH);
  if (!ct || ct.includes(footerFileName)) {
    return;
  }

  const override =
    `<Override PartName="/word/${footerFileName}"` +
    ` ContentType="${FOOTER_CONTENT_TYPE}"/>`;
  archive.zip.file(
    CONTENT_TYPES_PATH,
    ct.replace("</Types>", () => `${override}\n</Types>`),
  );
};

// ── Footer Extraction (fallback) ────────────────────────

const parseFooterStamp = async (
  archive: DocxArchive,
): Promise<{
  verificationCode: string | null;
  stamp: string | null;
}> => {
  const footerFiles = Object.keys(archive.zip.files).filter((path) =>
    FOOTER_FILE_RE.test(path),
  );

  for (const path of footerFiles) {
    const xml = await archive.readEntryString(path);
    if (!xml || !xml.includes(STAMP_BOOKMARK)) {
      continue;
    }

    const result = extractBookmarkText(xml);
    if (result) {
      return result;
    }
  }

  return { verificationCode: null, stamp: null };
};

/** Concatenated `<w:t>` text of a run-bearing region, in document order. */
const collectRunText = (xml: string): string => {
  const texts: string[] = [];
  for (const match of xml.matchAll(WT_TEXT_RE)) {
    const text = match.groups?.["text"];
    if (text) {
      texts.push(text);
    }
  }
  return texts.join("");
};

const extractBookmarkText = (
  xml: string,
): {
  verificationCode: string | null;
  stamp: string | null;
} | null => {
  const re = new RegExp(
    `<w:bookmarkStart[^>]*w:name="${STAMP_BOOKMARK}"` +
      "[\\s\\S]*?<w:bookmarkEnd[^>]*/>",
    "u",
  );
  const match = re.exec(xml);
  if (!match) {
    return null;
  }

  const fullText = collectRunText(match[0]).trim();
  if (!fullText) {
    return null;
  }

  // Parse "2026/001/015.v3  stl:kx8mq2n4p3"
  const stlMatch = STL_CODE_RE.exec(fullText);
  const verificationCode = stlMatch?.groups?.["code"] ?? null;

  // Stamp is everything before "stl:"
  const stampPart = fullText.replace(STL_SUFFIX_RE, "").trim();

  return {
    verificationCode,
    stamp: stampPart || null,
  };
};

// ── Custom Property Extraction ──────────────────────────

const parseCustomProperty = (xml: string, name: string): string | null => {
  const re = new RegExp(
    `<property[^>]*name="${name}"[^>]*>\\s*<vt:lpwstr>([^<]*)</vt:lpwstr>`,
    "u",
  );
  const match = re.exec(xml);
  return match?.[1] ?? null;
};

// ── XML Utilities ───────────────────────────────────────

const escapeXml = (str: string): string =>
  str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
