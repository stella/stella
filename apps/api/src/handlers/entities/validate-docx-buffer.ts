import JSZip from "jszip";
import * as slimdom from "slimdom";

export type ValidateDocxBufferResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * Validate that a buffer is a structurally valid DOCX file.
 * Checks that the ZIP archive can be parsed, that it contains
 * the required `word/document.xml` entry, and that document XML
 * is well-formed.
 */
export const validateDocxBuffer = async (
  buffer: ArrayBuffer,
): Promise<ValidateDocxBufferResult> => {
  try {
    const zip = await JSZip.loadAsync(buffer);

    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      return { valid: false, error: "Missing word/document.xml" };
    }

    const xml = await documentXml.async("text");

    let document: slimdom.Document;
    try {
      document = slimdom.parseXmlDocument(xml);
    } catch (error) {
      return {
        valid: false,
        error: `Malformed document.xml: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }

    const root = document.documentElement;
    if (!root || root.localName !== "document") {
      return {
        valid: false,
        error: "Malformed document.xml: missing root element",
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Invalid DOCX: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
};
