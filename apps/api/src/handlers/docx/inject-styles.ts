/**
 * XML surgery: replaces styles.xml and numbering.xml in a generated
 * DOCX with those from a reference template. This imports all of the
 * template's custom styles into the output document so users see them
 * in the Word style picker.
 *
 * Also copies theme and fontTable if present, so fonts resolve
 * correctly.
 *
 * The language attribute (w:lang w:val) in styles.xml is rewritten
 * to match the requested locale so the document isn't locked to the
 * template author's language.
 */

import JSZip from "jszip";

const DEFAULT_LANG = "en-US";

/** XML parts to transplant from the template into the output. */
const PARTS_TO_COPY = [
  "word/styles.xml",
  "word/numbering.xml",
  "word/theme/theme1.xml",
  "word/fontTable.xml",
] as const;

/**
 * Rewrite all `w:lang w:val` attributes in styles.xml to use the
 * target language. The `w:val` attribute controls proofing language
 * (spell check, grammar). `w:eastAsia` and `w:bidi` are left
 * unchanged.
 */
const rewriteLanguage = (stylesXml: string, lang: string): string =>
  stylesXml.replace(
    /(<w:lang\b[^>]*?\bw:val=")([^"]+)(")/g,
    (_, p1, _p2, p3) => `${p1}${lang}${p3}`,
  );

/**
 * Load the reference template's XML parts.
 * The fixture is bundled with the app; in the future this will
 * come from the user's uploaded template stored in S3.
 */
const loadTemplateParts = async (
  templatePath: string,
): Promise<Map<string, string>> => {
  const file = Bun.file(templatePath);
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);

  const parts = new Map<string, string>();
  for (const partPath of PARTS_TO_COPY) {
    const entry = zip.file(partPath);
    if (entry) {
      parts.set(partPath, await entry.async("string"));
    }
  }
  return parts;
};

export type InjectStylesOptions = {
  /** BCP-47 language tag (e.g., "en-US", "de-DE", "cs-CZ").
   *  Defaults to "en-US". */
  lang?: string;
};

/**
 * Replace XML parts in a generated DOCX buffer with those from
 * the reference template, rewriting the language to `lang`.
 */
export const injectStyles = async (
  generatedBuffer: Buffer,
  templatePath: string,
  options: InjectStylesOptions = {},
): Promise<Buffer> => {
  const lang = options.lang ?? DEFAULT_LANG;
  const templateParts = await loadTemplateParts(templatePath);
  const zip = await JSZip.loadAsync(generatedBuffer);

  for (const [partPath, xml] of templateParts) {
    const processed =
      partPath === "word/styles.xml" ? rewriteLanguage(xml, lang) : xml;
    zip.file(partPath, processed);
  }

  const result = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });

  return Buffer.from(result);
};
