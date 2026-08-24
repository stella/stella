import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { resolveReviewSelection } from "@/api/handlers/document-reviews/review-selection";
import { toSafeId } from "@/api/lib/branded-types";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const targetEntityId = toSafeId<"entity">(
  "00000000-0000-0000-0000-000000000001",
);
const referenceEntityId = toSafeId<"entity">(
  "00000000-0000-0000-0000-000000000002",
);
const targetVersionId = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000003",
);
const referenceVersionId = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000004",
);
const targetFieldId = toSafeId<"field">("00000000-0000-0000-0000-000000000005");
const referenceFieldId = toSafeId<"field">(
  "00000000-0000-0000-0000-000000000006",
);

const fileContent = (mimeType: string) => ({
  version: 1 as const,
  type: "file" as const,
  id: "00000000-0000-0000-0000-000000000007",
  fileName: mimeType === DOCX_MIME_TYPE ? "agreement.docx" : "agreement.pdf",
  mimeType,
  sizeBytes: 1024,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: "00000000-0000-0000-0000-000000000008",
});

const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000009",
);

const entityRows = (referenceMimeType: string = DOCX_MIME_TYPE) => [
  {
    id: targetEntityId,
    workspaceId,
    currentVersion: {
      id: targetVersionId,
      fields: [{ id: targetFieldId, content: fileContent(DOCX_MIME_TYPE) }],
    },
  },
  {
    id: referenceEntityId,
    workspaceId,
    currentVersion: {
      id: referenceVersionId,
      fields: [
        { id: referenceFieldId, content: fileContent(referenceMimeType) },
      ],
    },
  },
];

const target = {
  workspaceId,
  entityId: targetEntityId,
  fileFieldId: targetFieldId,
};
const reference = {
  workspaceId,
  entityId: referenceEntityId,
  fileFieldId: referenceFieldId,
};

describe("document review selection", () => {
  test("resolves current DOCX fields and forces block-based preparation", () => {
    const result = resolveReviewSelection({
      target,
      references: [reference],
      entities: entityRows(),
    }).unwrap();

    expect(result.target.entityVersionId).toBe(targetVersionId);
    expect(result.references.at(0)?.entityVersionId).toBe(referenceVersionId);
    expect(result.target.file.pdfFileId).toBeNull();
    expect(result.references.at(0)?.file.pdfFileId).toBeNull();
  });

  test("rejects duplicate references and selecting the target as a reference", () => {
    const duplicate = resolveReviewSelection({
      target,
      references: [reference, reference],
      entities: entityRows(),
    });
    const selfReference = resolveReviewSelection({
      target,
      references: [target],
      entities: entityRows(),
    });

    expect(Result.isError(duplicate)).toBe(true);
    expect(Result.isError(selfReference)).toBe(true);
    if (Result.isOk(duplicate) || Result.isOk(selfReference)) {
      return;
    }
    expect(duplicate.error.status).toBe(422);
    expect(selfReference.error.status).toBe(422);
  });

  test("does not distinguish a missing entity from a mismatched field", () => {
    const missingEntity = resolveReviewSelection({
      target,
      references: [reference],
      entities: entityRows().slice(0, 1),
    });
    const mismatchedField = resolveReviewSelection({
      target,
      references: [
        {
          workspaceId,
          entityId: referenceEntityId,
          fileFieldId: toSafeId<"field">(
            "00000000-0000-0000-0000-000000000009",
          ),
        },
      ],
      entities: entityRows(),
    });

    expect(Result.isError(missingEntity)).toBe(true);
    expect(Result.isError(mismatchedField)).toBe(true);
    if (Result.isOk(missingEntity) || Result.isOk(mismatchedField)) {
      return;
    }
    expect(missingEntity.error).toMatchObject({
      status: 404,
      message: "Document not found",
    });
    expect(mismatchedField.error).toMatchObject({
      status: 404,
      message: "Document not found",
    });
  });

  test("rejects non-DOCX references after ownership resolution", () => {
    const result = resolveReviewSelection({
      target,
      references: [reference],
      entities: entityRows(PDF_MIME_TYPE),
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error.status).toBe(422);
  });
});
