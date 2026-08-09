import { describe, expect, test } from "bun:test";

import {
  DESKTOP_EDIT_FILE_TYPES,
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
  desktopEditFileTypeForMimeType,
  isDesktopEditFileType,
} from "./desktop-edit-file-types";

describe("desktop edit file types", () => {
  test("accepts every canonical file type and rejects unsupported values", () => {
    for (const fileType of DESKTOP_EDIT_FILE_TYPES) {
      expect(isDesktopEditFileType(fileType)).toBe(true);
    }

    expect(isDesktopEditFileType("pdf")).toBe(false);
    expect(isDesktopEditFileType(null)).toBe(false);
  });
});

describe("desktop edit MIME classification", () => {
  test("classifies every supported MIME independent of casing and parameters", () => {
    for (const fileType of DESKTOP_EDIT_FILE_TYPES) {
      const mimeType = DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType].mimeType;

      expect(
        desktopEditFileTypeForMimeType(
          ` ${mimeType.toUpperCase()} ; charset=binary`,
        ),
      ).toBe(fileType);
    }
  });

  test("rejects unsupported and empty MIME types", () => {
    expect(desktopEditFileTypeForMimeType("application/pdf")).toBeNull();
    expect(desktopEditFileTypeForMimeType(" ; charset=binary")).toBeNull();
  });
});
