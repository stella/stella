import { expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";

import {
  selectCanonicalFileContents,
  type DeletionFileFieldRow,
} from "./delete-file-snapshot";

const fileContent = (
  fileName: string,
): Extract<FieldContent, { type: "file" }> => ({
  encrypted: false,
  fileName,
  id: "00000000-0000-0000-0000-000000000001",
  mimeType: "application/pdf",
  pdfFileId: null,
  sha256Hex: "0".repeat(64),
  sizeBytes: 1,
  type: "file",
  version: 1,
});

test("selects the lowest-ID current-version file regardless of row order", () => {
  const fieldRows: DeletionFileFieldRow[] = [
    {
      content: fileContent("secondary.pdf"),
      entityVersionId: "version-1",
      id: "00000000-0000-0000-0000-000000000002",
    },
    {
      content: fileContent("primary.pdf"),
      entityVersionId: "version-1",
      id: "00000000-0000-0000-0000-000000000001",
    },
  ];

  expect(
    selectCanonicalFileContents(
      fieldRows,
      new Map([["version-1", "entity-1"]]),
    ).get("entity-1")?.fileName,
  ).toBe("primary.pdf");
});
