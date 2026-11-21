/**
 * Whether a set of matters is every matter the reader can open, so it reads
 * as "All matters" rather than as a list of names. The chat matter picker
 * labels its selection by it and the chat history labels a chat that drew on
 * every matter by it, so the two always agree.
 *
 * `total` is the reader's matter list (the navigation list both surfaces
 * read). A count above it still covers every matter: the list can shrink
 * after a chat drew on a matter that is since archived or no longer shared.
 */
export const coversAllMatters = ({
  count,
  total,
}: {
  count: number;
  total: number;
}): boolean => total > 0 && count >= total;
