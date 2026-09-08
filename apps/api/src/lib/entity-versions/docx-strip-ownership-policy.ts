import type { REVIEWED_VERSION_MUTATION_OWNERS } from "@/api/lib/entity-versions/version-write-ownership-policy";

/**
 * What a module does with the file bytes behind a document or a version.
 *
 * Stored DOCX bytes must never carry a stella document reference, and no single
 * module owns object placement: the persistence transaction
 * (`writeFileVersion`) never sees bytes, and the byte writers are split across
 * the presigned transport, the server-generated buffer writers, the legacy
 * multipart handler, and the two durable edit-session protocols. This map is
 * therefore the register: every module that may write version bytes states
 * which side of the invariant it is on.
 */
export const STORED_BYTE_DISPOSITION = {
  /**
   * Introduces bytes from outside object storage. Must run
   * `storedDocumentBytes` and derive the recorded size and hash from its
   * result.
   */
  STRIPS_REFERENCE: "strips-reference",
  /** Receives bytes an upstream owner in this map already stripped. */
  STRIPPED_UPSTREAM: "stripped-upstream",
  /**
   * Writes no file bytes: it copies a stored object, points a new version at an
   * existing one, or touches only rows.
   */
  NO_NEW_BYTES: "no-new-bytes",
} as const;

type StoredByteDisposition =
  (typeof STORED_BYTE_DISPOSITION)[keyof typeof STORED_BYTE_DISPOSITION];

/**
 * Byte writers that own no version-row mutation of their own.
 * `handlers/uploads/update.ts` is the presigned finalize runtime: it downloads
 * the staged object, scans it, and hands bytes, size and hash to whichever
 * purpose finalizer commits them, so stripping there covers every presigned
 * transport at once (web, desktop, CLI, and the MCP file bridge).
 */
const NON_VERSION_OWNER_BYTE_WRITERS = ["handlers/uploads/update.ts"] as const;

type DocumentByteWriter =
  | keyof typeof REVIEWED_VERSION_MUTATION_OWNERS
  | (typeof NON_VERSION_OWNER_BYTE_WRITERS)[number];

/**
 * Total over every reviewed version-mutation owner, so a new one cannot land
 * without deciding. `docx-strip-ownership-policy.test.ts` checks each
 * declaration against the module's source.
 */
export const DOCUMENT_BYTE_WRITE_DISPOSITION = {
  "handlers/entities/clip.ts": STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "handlers/entities/copy-utils.ts": STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "handlers/entities/create.ts": STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "handlers/entities/delete-version.ts": STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "handlers/entities/finalize-desktop-edit-session.ts":
    STORED_BYTE_DISPOSITION.STRIPS_REFERENCE,
  "handlers/entities/publish-folio-collab-version.ts":
    STORED_BYTE_DISPOSITION.STRIPS_REFERENCE,
  "handlers/entities/restore-version.ts": STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "handlers/entities/upload.ts": STORED_BYTE_DISPOSITION.STRIPS_REFERENCE,
  "handlers/uploads/entity-create-tree.ts":
    STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "handlers/uploads/entity-version.ts":
    STORED_BYTE_DISPOSITION.STRIPPED_UPSTREAM,
  "handlers/uploads/update.ts": STORED_BYTE_DISPOSITION.STRIPS_REFERENCE,
  "handlers/workspaces/duplicate.ts": STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "lib/entities/create-from-buffer.ts":
    STORED_BYTE_DISPOSITION.STRIPS_REFERENCE,
  "lib/entity-versions/create-entity-version-from-buffer.ts":
    STORED_BYTE_DISPOSITION.STRIPS_REFERENCE,
  "lib/entity-versions/insert-entity-version.ts":
    STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "lib/entity-versions/write-file-version.ts":
    STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "lib/infosoud/agenda-import.ts": STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "lib/tasks/create-task-entity.ts": STORED_BYTE_DISPOSITION.NO_NEW_BYTES,
  "lib/uploads/entity-create.ts": STORED_BYTE_DISPOSITION.STRIPPED_UPSTREAM,
} as const satisfies Record<DocumentByteWriter, StoredByteDisposition>;
