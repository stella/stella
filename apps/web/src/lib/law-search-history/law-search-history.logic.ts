// Keep the key so existing owner-scoped searches migrate without a second store.
export { LAW_HISTORY_STORAGE_KEY } from "@/lib/account/storage-keys";
export {
  lawRecentKey,
  readLawRecent,
} from "@/lib/law-search-history/law-search-history.rows";
export type { LawRecentFilter } from "@/lib/law-search-history/law-search-history.schema";

// A display limit only; the server retains entries until their owner deletes them.
export const LAW_HISTORY_DISPLAY_LIMIT = 20;
