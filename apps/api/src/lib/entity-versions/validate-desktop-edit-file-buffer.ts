import * as slimdom from "slimdom";

import {
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
  type DesktopEditFileType,
} from "@/api/lib/desktop-edit-file-types";
import { loadDocxArchive } from "@/api/lib/docx-archive";

const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";

export type ValidateDesktopEditFileBufferResult =
  | { valid: true }
  | { valid: false; error: string };

export const validateDesktopEditFileBuffer = async ({
  buffer,
  fileType,
}: {
  buffer: ArrayBuffer;
  fileType: DesktopEditFileType;
}): Promise<ValidateDesktopEditFileBufferResult> => {
  const config = DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType];

  try {
    const archive = await loadDocxArchive(buffer);
    const contentTypesXml = await archive.readEntryString(
      "[Content_Types].xml",
    );
    if (contentTypesXml === null) {
      return { valid: false, error: "Missing [Content_Types].xml" };
    }

    let contentTypesDocument: slimdom.Document;
    try {
      contentTypesDocument = slimdom.parseXmlDocument(contentTypesXml);
    } catch (error) {
      return {
        valid: false,
        error: `Malformed [Content_Types].xml: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }

    const contentTypesRoot = contentTypesDocument.documentElement;
    if (
      contentTypesRoot?.localName !== "Types" ||
      contentTypesRoot.namespaceURI !== CONTENT_TYPES_NAMESPACE
    ) {
      return {
        valid: false,
        error: "Malformed [Content_Types].xml: unexpected root element",
      };
    }

    const mainPartXml = await archive.readEntryString(config.mainPartPath);
    if (mainPartXml === null) {
      return { valid: false, error: `Missing ${config.mainPartPath}` };
    }

    let document: slimdom.Document;
    try {
      document = slimdom.parseXmlDocument(mainPartXml);
    } catch (error) {
      return {
        valid: false,
        error: `Malformed ${config.mainPartPath}: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }

    if (
      document.documentElement?.localName !== config.mainRootLocalName ||
      document.documentElement.namespaceURI !== config.mainRootNamespace
    ) {
      return {
        valid: false,
        error: `Malformed ${config.mainPartPath}: unexpected root element`,
      };
    }

    const expectedPartName = `/${config.mainPartPath}`;
    const hasMainPartOverride = contentTypesRoot
      .getElementsByTagNameNS(CONTENT_TYPES_NAMESPACE, "Override")
      .some(
        (override) =>
          override.getAttribute("PartName") === expectedPartName &&
          override.getAttribute("ContentType") === config.mainPartContentType,
      );
    if (!hasMainPartOverride) {
      return {
        valid: false,
        error: `Malformed [Content_Types].xml: missing ${expectedPartName} override`,
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Invalid ${fileType.toUpperCase()}: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
};
