import { filterBySearchQuery } from "@stll/text-normalize/search-query-matcher";

type SearchableDocument = {
  fileName: string;
  /** The entity's own name when it differs from the file's; null when unset. */
  name: string | null;
};

/**
 * Documents whose file name or entity name contains the query, accent- and
 * case-insensitively, in their given order. A blank query keeps every one.
 */
export const filterDocumentsByQuery = <TDocument extends SearchableDocument>(
  documents: readonly TDocument[],
  query: string,
): readonly TDocument[] =>
  filterBySearchQuery({
    items: documents,
    query,
    fields: ({ fileName, name }) => [fileName, name],
  });
