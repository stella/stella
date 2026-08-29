import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";

export const FOLIO_COLLAB_ROOM_SEED_STATES = [
  "empty",
  "claimed",
  "seeded",
] as const;

export type FolioCollabRoomSeedState =
  (typeof FOLIO_COLLAB_ROOM_SEED_STATES)[number];

/** Room tokens are renewable credentials; expiry never deletes room state. */
export const FOLIO_COLLAB_TOKEN_TTL_MS = 60 * 60 * 1000;

/** A lost seed claimant may be replaced after several missed heartbeats. */
export const FOLIO_COLLAB_SEED_CLAIM_STALE_MS = 2 * 60 * 1000;

/**
 * Desktop editing treats a room as occupied only while an authenticated
 * collaboration server is renewing this activity lease.
 */
export const FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

/** Yjs recovery updates are bounded independently from materialized DOCX. */
export const FOLIO_COLLAB_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;
export const FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH =
  Math.ceil(FOLIO_COLLAB_SNAPSHOT_MAX_BYTES / 3) * 4;

/** Materialized checkpoints obey the canonical document upload ceiling. */
export const FOLIO_COLLAB_CHECKPOINT_MAX_BYTES = FILE_SIZE_LIMIT_BYTES.document;
