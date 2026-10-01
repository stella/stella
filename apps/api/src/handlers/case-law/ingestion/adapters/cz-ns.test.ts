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

  for (const member of [
    null,
    "invalid",
    { "@unid": 123 },
    { entrydata: [{ text: 42 }] },
  ]) {
    test(`isolates malformed member ${JSON.stringify(member)} from the listing envelope`, async () => {
      spyOn(globalThis, "fetch").mockImplementation(
        asFetchMock(
          async (url: string | URL | Request) =>
            new Response(
              String(url).includes("ReadViewEntries")
                ? JSON.stringify({
                    "@toplevelentries": "2",
                    viewentry: [
                      member,
                      {
                        "@unid": "0123456789abcdef0123456789abcdef",
                        entrydata: [
                          { "@name": "znacka", text: { "0": "1 Cdo 1/2026" } },
                        ],
                      },
                    ],
                  })
                : "<html><body><p>Rozhodnutí soudu.</p></body></html>",
            ),
        ),
      );
      const page = (await czNsAdapter.fetchPage("1", {})).unwrap();
      expect(page.nextCursor).toBe("3");
      expect(page.itemBuildFailures).toEqual({
        type: "item_build_failed",
        count: 1,
      });
      expect(page.decisions).toHaveLength(1);
      expect(page.decisions.at(0)?.sourceDocumentId).toBe(
        "0123456789abcdef0123456789abcdef",
      );
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
