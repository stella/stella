import { Result } from "better-result";
import { expect, test } from "bun:test";

import { pgFtsLegalProvider } from "@/api/lib/legal-search/pg-fts-legal-provider";
import { InvalidLegalSearchCursorError } from "@/api/lib/legal-search/search-error";

test("an undecodable cursor fails before Postgres search work", async () => {
  const result = await pgFtsLegalProvider.search({
    cursor: "not a cursor",
    limit: 10,
    query: "nájemné",
  });

  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    return;
  }
  expect(result.error).toBeInstanceOf(InvalidLegalSearchCursorError);
  expect(result.error).toMatchObject({ reason: "undecodable" });
});
