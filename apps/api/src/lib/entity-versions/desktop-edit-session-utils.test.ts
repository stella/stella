import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import {
  DESKTOP_EDIT_FILE_TYPES,
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
} from "@/api/lib/desktop-edit-file-types";

import { asDesktopEditableFileContent } from "./desktop-edit-session-utils";

type FileFieldContent = Extract<FieldContent, { type: "file" }>;

const fileContent = (mimeType: string): FileFieldContent => ({
  encrypted: false,
  fileName: "office-file",
  id: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
  mimeType,
  pdfFileId: null,
  sha256Hex: "a".repeat(64),
  sizeBytes: 123,
  type: "file",
  version: 1,
});

describe("desktop editable file classification", () => {
  test("preserves the stored MIME used to locate every supported file", () => {
    for (const fileType of DESKTOP_EDIT_FILE_TYPES) {
      const canonicalMimeType = DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType].mimeType;
      const storedMimeType = ` ${canonicalMimeType.toUpperCase()} ; charset=binary`;
      const content = fileContent(storedMimeType);

      const target = asDesktopEditableFileContent(content);

      expect(target?.fileType).toBe(fileType);
      expect(target?.fileContent).toBe(content);
      expect(target?.fileContent.mimeType).toBe(storedMimeType);
    }
  });
});
