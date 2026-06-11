import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db";
import type { FieldContent } from "@/api/db/schema-validators";
import { THUMBNAIL_MIME_TYPE } from "@/api/handlers/files/image-derivative";
import { toSafeId } from "@/api/lib/branded-types";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  extractFieldFileRefs,
  filterUnreferencedFieldFileRefs,
} from "./field-file-refs";

const fileContent = {
  encrypted: false,
  fileName: "source.docx",
  id: "source-file",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdfFileId: "pdf-file",
  sha256Hex: "a".repeat(64),
  sizeBytes: 64,
  thumbnailFileId: "thumbnail-file",
  type: "file",
  version: 1,
} satisfies FieldContent;

describe("field file refs", () => {
  test("extracts source, pdf, and thumbnail refs", () => {
    expect(extractFieldFileRefs(fileContent)).toEqual([
      {
        fileId: "source-file",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      { fileId: "pdf-file", mimeType: PDF_MIME_TYPE },
      { fileId: "thumbnail-file", mimeType: THUMBNAIL_MIME_TYPE },
    ]);
  });

  test("keeps only refs with no live field reference", async () => {
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: async () => [{ content: fileContent }],
          }),
        }),
      }),
    });

    const result = await filterUnreferencedFieldFileRefs({
      tx,
      workspaceId: toSafeId<"workspace">("workspace_1"),
      fileRows: [
        { fileId: "source-file", mimeType: fileContent.mimeType },
        { fileId: "pdf-file", mimeType: PDF_MIME_TYPE },
        { fileId: "thumbnail-file", mimeType: THUMBNAIL_MIME_TYPE },
        { fileId: "orphan-file", mimeType: fileContent.mimeType },
      ],
    });

    expect(result).toEqual([
      { fileId: "orphan-file", mimeType: fileContent.mimeType },
    ]);
  });
});
