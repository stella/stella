import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { PublisherPageError } from "@/api/handlers/case-law/ingestion/adapters/publisher-page";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

describe("Domino listings distinguish publisher refusal from an empty view", () => {
  afterEach(() => mock.restore());

  for (const body of [
    "<html><form><input type='password'></form></html>",
    "{}",
    '{"viewentry":[]}',
    '{"@toplevelentries":"1"}',
    '{"@toplevelentries":',
    "",
  ]) {
    test(`rejects an unreadable page ${JSON.stringify(body)}`, async () => {
      spyOn(globalThis, "fetch").mockImplementation(
        asFetchMock(async () => new Response(body)),
      );
      const page = await czNsAdapter.fetchPage("1", {});
      expect(page.isErr()).toBe(true);
      if (page.isErr()) {
        expect(page.error).toBeInstanceOf(PublisherPageError);
      }
    });
  }

  test("accepts the publisher's explicit small empty view", async () => {
    spyOn(globalThis, "fetch").mockImplementation(
      asFetchMock(async () => new Response('{"@toplevelentries":"0"}')),
    );
    const page = await czNsAdapter.fetchPage("1", {});
    expect(page.isOk()).toBe(true);
    if (page.isOk()) {
      expect(page.value.decisions).toEqual([]);
      expect(page.value.nextCursor).toBe("1");
    }
  });
});
