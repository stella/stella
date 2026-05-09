import JSZip from "jszip";

export type ValidateDocxPackageResult =
  | { valid: true }
  | { valid: false; error: string };

export const validateDocxPackage = async (
  buffer: ArrayBuffer | Uint8Array,
): Promise<ValidateDocxPackageResult> => {
  try {
    const zip = await JSZip.loadAsync(buffer);
    for (const requiredPath of [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/_rels/document.xml.rels",
    ]) {
      if (!zip.file(requiredPath)) {
        return {
          valid: false,
          error: `Generated DOCX is missing required package part: ${requiredPath}`,
        };
      }
    }

    const documentXml = await zip.file("word/document.xml")?.async("string");
    if (!documentXml?.includes("<w:document")) {
      return {
        valid: false,
        error: "Generated DOCX has no word/document.xml root document.",
      };
    }

    const documentRelsXml = await zip
      .file("word/_rels/document.xml.rels")
      ?.async("string");
    if (
      documentRelsXml?.includes("/relationships/numbering") &&
      !zip.file("word/numbering.xml")
    ) {
      return {
        valid: false,
        error:
          "Generated DOCX references numbering.xml but does not include it.",
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid DOCX package.",
    };
  }
};
