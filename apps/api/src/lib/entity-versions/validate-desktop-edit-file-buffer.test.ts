import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  DESKTOP_EDIT_FILE_TYPES,
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
  type DesktopEditFileType,
} from "@/api/lib/desktop-edit-file-types";

import { validateDesktopEditFileBuffer } from "./validate-desktop-edit-file-buffer";

const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";

type MakePackageOptions = {
  fileType: DesktopEditFileType;
  mainPartContentType?: string;
  mainRootNamespace?: string;
};

const makePackage = async ({
  fileType,
  mainPartContentType,
  mainRootNamespace,
}: MakePackageOptions) => {
  const config = DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType];
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/${config.mainPartPath}" ContentType="${mainPartContentType ?? config.mainPartContentType}"/></Types>`,
  );
  zip.file(
    config.mainPartPath,
    `<?xml version="1.0"?><x:${config.mainRootLocalName} xmlns:x="${mainRootNamespace ?? config.mainRootNamespaces[0]}"/>`,
  );
  return await zip.generateAsync({ type: "arraybuffer" });
};

describe("desktop edit file validation", () => {
  for (const fileType of DESKTOP_EDIT_FILE_TYPES) {
    test(`accepts every standard ${fileType} namespace`, async () => {
      const config = DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType];

      for (const mainRootNamespace of config.mainRootNamespaces) {
        const buffer = await makePackage({ fileType, mainRootNamespace });

        expect(
          await validateDesktopEditFileBuffer({ buffer, fileType }),
        ).toEqual({ valid: true });
      }
    });

    test(`rejects a ${fileType} package with the wrong main namespace`, async () => {
      const buffer = await makePackage({
        fileType,
        mainRootNamespace: "urn:wrong-office-namespace",
      });

      expect(await validateDesktopEditFileBuffer({ buffer, fileType })).toEqual(
        {
          valid: false,
          error: `Malformed ${DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType].mainPartPath}: unexpected root element`,
        },
      );
    });

    test(`rejects a ${fileType} package with the wrong main-part content type`, async () => {
      const config = DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType];
      const buffer = await makePackage({
        fileType,
        mainPartContentType: "application/xml",
      });

      expect(await validateDesktopEditFileBuffer({ buffer, fileType })).toEqual(
        {
          valid: false,
          error: `Malformed [Content_Types].xml: missing /${config.mainPartPath} override`,
        },
      );
    });
  }

  test("rejects a valid package from a different Office family", async () => {
    const buffer = await makePackage({ fileType: "xlsx" });

    expect(
      await validateDesktopEditFileBuffer({ buffer, fileType: "pptx" }),
    ).toEqual({
      valid: false,
      error: "Missing ppt/presentation.xml",
    });
  });

  test("rejects a package without content type declarations", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    );
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    expect(
      await validateDesktopEditFileBuffer({ buffer, fileType: "docx" }),
    ).toEqual({
      valid: false,
      error: "Missing [Content_Types].xml",
    });
  });

  test("rejects a malformed main part", async () => {
    const config = DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx;
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0"?><Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/${config.mainPartPath}" ContentType="${config.mainPartContentType}"/></Types>`,
    );
    zip.file(
      config.mainPartPath,
      `<x:workbook xmlns:x="${config.mainRootNamespaces[0]}">`,
    );
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    const result = await validateDesktopEditFileBuffer({
      buffer,
      fileType: "xlsx",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Malformed xl/workbook.xml");
    }
  });
});
