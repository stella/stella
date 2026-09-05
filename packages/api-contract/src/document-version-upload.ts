export const DOCUMENT_VERSION_UPLOAD_TRANSPORT = {
  capability: {
    abort: "uploads.delete",
    finalize: "uploads.update",
    reserve: "uploads.create",
  },
  pickerToolName: "open_document_version_upload",
  purpose: "entity_version",
  resourceUri: "ui://stella/document-version-upload",
  toolName: "upload_document_version",
} as const;

export const DOCUMENT_VERSION_UPLOAD_CAPABILITY_IDS: readonly string[] = [
  DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.reserve,
  DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.finalize,
  DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.abort,
] as const;

export type DocumentVersionUploadFileMetadata = {
  mimeType: string;
  name: string;
  sha256Hex: string;
  size: number;
};

// These build the input for `invoke_capability`, whose params speak the public
// vocabulary: the container a caller holds as a `workspaceId` goes on the wire
// as `matterId`. Callers pass the id they have; the rename happens here, once.
export type DocumentVersionUploadReservationInput = {
  body: DocumentVersionUploadFileMetadata & {
    entityId: string;
    purpose: typeof DOCUMENT_VERSION_UPLOAD_TRANSPORT.purpose;
  };
  params: { matterId: string };
};

export type UploadLifecycleInput = {
  params: { uploadId: string; matterId: string };
};

export const buildDocumentVersionUploadReservationInput = ({
  entityId,
  file,
  workspaceId,
}: {
  entityId: string;
  file: DocumentVersionUploadFileMetadata;
  workspaceId: string;
}): DocumentVersionUploadReservationInput => ({
  body: {
    purpose: DOCUMENT_VERSION_UPLOAD_TRANSPORT.purpose,
    entityId,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    sha256Hex: file.sha256Hex,
  },
  params: { matterId: workspaceId },
});

export const buildUploadAbortInput = ({
  uploadId,
  workspaceId,
}: {
  uploadId: string;
  workspaceId: string;
}): UploadLifecycleInput => ({ params: { uploadId, matterId: workspaceId } });

export const buildUploadFinalizeInput: typeof buildUploadAbortInput =
  buildUploadAbortInput;
