/**
 * Version marker for chat projections whose searchable text and
 * source-document metadata follow the current display-only contract. UUIDv7
 * generations written by the previous indexer cannot equal this reserved UUID,
 * and neither can an earlier reserved generation, so bumping it is how a
 * projection change re-indexes existing rows without a migration: the periodic
 * repair task (`search.repairChatIndex`, every five minutes) picks up every
 * thread whose `preview_generation` differs.
 *
 * `...0002` drops markdown link targets from the indexed text, so a chat hit's
 * headline no longer exposes the mention href behind a citation.
 */
export const CHAT_SEARCH_DISPLAY_METADATA_GENERATION =
  "00000000-0000-0000-0000-000000000002" as const;
