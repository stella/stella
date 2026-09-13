import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  DOCUMENT_REFERENCE_EVIDENCE,
  REFERENCE_UPLOAD_ACTION,
} from "@/lib/files/document-reference";
import type { ReferencedFile } from "@/lib/files/document-reference-queries";

import type { ReferencedFileRowState } from "./document-reference-upload-dialog.logic";
import { uploadReferencedVersions } from "./document-reference-upload-dialog.logic";

const referencedFile = (name: string): ReferencedFile => ({
  file: new File([name], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }),
  evidence: DOCUMENT_REFERENCE_EVIDENCE.propertiesAndFooter,
  match: {
    entityId: `entity-${name}`,
    entityName: name,
    workspaceId: "workspace-1",
    workspaceName: "Example matter",
    stamp: "2026/001/015.v3",
    versionNumber: 3,
    currentVersionNumber: 3,
  },
});

const row = (
  id: string,
  choice: ReferencedFileRowState["choice"],
): ReferencedFileRowState => ({
  id,
  choice,
  entry: referencedFile(`${id}.docx`),
});

test("keeps only failed version rows and new documents for retry", async () => {
  const successful = row("successful", REFERENCE_UPLOAD_ACTION.version);
  const failed = row("failed", REFERENCE_UPLOAD_ACTION.version);
  const newDocument = row("new", REFERENCE_UPLOAD_ACTION.newDocument);
  const attempts: string[] = [];

  const first = await uploadReferencedVersions({
    rows: [successful, failed, newDocument],
    uploadVersion: async ({ file }) => {
      attempts.push(file.name);
      if (file === failed.entry.file) {
        return Result.err(new TypeError("simulated network failure"));
      }
      return Result.ok(undefined);
    },
  });

  expect(first.type).toBe("retry");
  if (first.type !== "retry") {
    throw new TypeError("expected a retry outcome");
  }
  expect(first.rows).toEqual([failed, newDocument]);
  expect(attempts).toEqual(["successful.docx", "failed.docx"]);

  const second = await uploadReferencedVersions({
    rows: first.rows,
    uploadVersion: async ({ file }) => {
      attempts.push(file.name);
      return Result.ok(undefined);
    },
  });

  expect(second).toEqual({
    type: "complete",
    newDocumentFiles: [newDocument.entry.file],
  });
  expect(attempts).toEqual(["successful.docx", "failed.docx", "failed.docx"]);
});
