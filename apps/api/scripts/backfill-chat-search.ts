/**
 * Backfill the chat-thread search index for every existing thread.
 *
 * Run once after the `chat-thread-search-documents` migration is
 * applied. Idempotent and resumable: only threads without a search
 * document are indexed, so re-running is safe.
 *
 * Usage:
 *   bun apps/api/scripts/backfill-chat-search.ts
 */

import { backfillChatThreadSearchIndex } from "@/api/lib/search/index-chat";

const main = async () => {
  const indexed = await backfillChatThreadSearchIndex();
  console.log(`Chat search backfill complete: ${indexed} thread(s) indexed.`);
  process.exit(0);
};

main().catch((error: unknown) => {
  console.error("Chat search backfill failed:", error);
  process.exit(1);
});
