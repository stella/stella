import { describe, expect, test } from "bun:test";

import {
  buildDocumentVersionUploadReservationInput,
  buildUploadAbortInput,
  buildUploadFinalizeInput,
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
} from "./document-version-upload";

describe("document version upload transport contract", () => {
  test("builds the one reservation and lifecycle wire shape", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const uploadId = "00000000-0000-4000-8000-000000000002";

    expect(
      buildDocumentVersionUploadReservationInput({
        entityId: "00000000-0000-4000-8000-000000000003",
        file: {
          mimeType: "application/octet-stream",
          name: "agreement.docx",
          sha256Hex: "a".repeat(64),
          size: 42,
        },
        workspaceId,
      }),
    ).toEqual({
      body: {
        purpose: DOCUMENT_VERSION_UPLOAD_TRANSPORT.purpose,
        entityId: "00000000-0000-4000-8000-000000000003",
        mimeType: "application/octet-stream",
        name: "agreement.docx",
        sha256Hex: "a".repeat(64),
        size: 42,
      },
      // The wire params speak the public vocabulary; the caller still holds the
      // id as a workspaceId.
      params: { matterId: workspaceId },
    });
    expect(buildUploadFinalizeInput({ uploadId, workspaceId })).toEqual(
      buildUploadAbortInput({ uploadId, workspaceId }),
    );
  });
});
