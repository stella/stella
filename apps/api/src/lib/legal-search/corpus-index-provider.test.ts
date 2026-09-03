import { expect, test } from "bun:test";

import { corpusIndexProvider } from "@/api/lib/legal-search/corpus-index-provider";
import { InvalidCorpusSearchCursorError } from "@/api/lib/legal-search/corpus-search-cursor";

// This provider has no HTTP status to answer with, so an undecodable cursor
// has to fail the read. Falling back to page one looks like a page to a client
// that appends, which silently duplicates everything it already has.
//
// The refusal also lands before the serving-generation read: a cursor is
// request input, and this assertion is only reachable at all because nothing
// queried a database or an engine first.
test("an undecodable cursor fails the read instead of restarting at page one", async () => {
  const rejection = await corpusIndexProvider
    .search({ cursor: "not a cursor", limit: 10, query: "nájemné" })
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(InvalidCorpusSearchCursorError);
  expect(
    rejection instanceof InvalidCorpusSearchCursorError
      ? rejection.reason
      : null,
  ).toBe("undecodable");
});
