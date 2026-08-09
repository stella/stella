import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  DESKTOP_EDIT_FILE_TYPES,
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
} from "@/api/lib/desktop-edit-file-types";

import { validateDesktopEditFileBuffer } from "./validate-desktop-edit-file-buffer";

const CONTENT_TYPES_XML =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

const makePackage = async ({
  mainPartPath,
  mainRootLocalName,
}: {
  mainPartPath: string;
  mainRootLocalName: string;
}) => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file(
    mainPartPath,
    `<?xml version="1.0"?><x:${mainRootLocalName} xmlns:x="urn:test"/>`,
  );
  return await zip.generateAsync({ type: "arraybuffer" });
};

describe("desktop edit file validation", () => {
  for (const fileType of DESKTOP_EDIT_FILE_TYPES) {
    test(`accepts a structurally valid ${fileType} package`, async () => {
      const config = DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType];
      const buffer = await makePackage(config);

      expect(await validateDesktopEditFileBuffer({ buffer, fileType })).toEqual(
        { valid: true },
      );
    });
  }

  test("rejects a valid package from a different Office family", async () => {
    const buffer = await makePackage(DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx);

    expect(
      await validateDesktopEditFileBuffer({ buffer, fileType: "pptx" }),
    ).toEqual({
      valid: false,
      error: "Missing ppt/presentation.xml",
    });
  });

  test("rejects a package without content type declarations", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", '<w:document xmlns:w="urn:test"/>');
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    expect(
      await validateDesktopEditFileBuffer({ buffer, fileType: "docx" }),
    ).toEqual({
      valid: false,
      error: "Missing [Content_Types].xml",
    });
  });

  test("rejects a malformed main part", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
    zip.file("xl/workbook.xml", '<x:workbook xmlns:x="urn:test">');
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
