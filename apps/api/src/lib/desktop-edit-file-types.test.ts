import { describe, expect, test } from "bun:test";

import {
  DESKTOP_EDIT_FILE_TYPES,
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
  desktopEditFileTypeForMimeType,
  desktopEditMimeTypeForFileType,
} from "./desktop-edit-file-types";

describe("desktop edit file types", () => {
  test("round-trips every supported file type through its canonical MIME", () => {
    for (const fileType of DESKTOP_EDIT_FILE_TYPES) {
      const mimeType = desktopEditMimeTypeForFileType(fileType);

      expect(desktopEditFileTypeForMimeType(mimeType)).toBe(fileType);
      expect(DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType].extension).toBe(
        `.${fileType}`,
      );
    }
  });

  test("rejects unsupported MIME types", () => {
    expect(desktopEditFileTypeForMimeType("application/pdf")).toBeNull();
  });
});
