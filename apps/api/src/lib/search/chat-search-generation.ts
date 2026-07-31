/**
 * Version marker for chat projections whose searchable source-document
 * metadata follows the current display-only contract. UUIDv7 generations
 * written by the previous indexer cannot equal this reserved UUID.
 */
export const CHAT_SEARCH_DISPLAY_METADATA_GENERATION =
  "00000000-0000-0000-0000-000000000001" as const;
