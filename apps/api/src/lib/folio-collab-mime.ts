/**
 * The media type a collaborative-editing snapshot is stored under, split out of
 * `folio-collab-rooms.ts` so a consumer that only needs to name the snapshot
 * object does not pull in that module's database and object-storage clients.
 * `folio-collab-rooms.ts` re-exports it, so writers keep their single import.
 */
export const FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE = "application/octet-stream";
