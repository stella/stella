import { docxSuggestions } from "@/api/db/schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { brandPersistedDocxSuggestionId } from "@/api/lib/safe-id-boundaries";

/**
 * Keyset cursor for the entity's suggestion list: oldest-first by
 * `(created_at, id)`, matching the `docx_suggestions_ws_entity_created_idx`
 * composite index. Kept in its own module (not exported from the endpoint)
 * per the domain-cursor-helper convention.
 *
 * The timestamp half is projected and compared at the column's microsecond
 * precision. Reading `created_at` into a JS `Date` truncates it to the
 * millisecond, and the ascending `>` boundary then still admits the row the
 * page was cut at: it is re-emitted as the first row of every following
 * page and the cursor never advances. Cursors issued in that older ISO form
 * keep decoding; the codec tags them millisecond-precision and truncates
 * the column on both sides so the page they were cut from resumes exactly.
 */
export const docxSuggestionCursor = createTimestampIdCursorCodec({
  column: docxSuggestions.createdAt,
  brandId: brandPersistedDocxSuggestionId,
});
