import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, test } from "bun:test";

import { statuteByEliOptions } from "@/features/case-law/queries/provisions";

const LISTINA_ELI = "https://www.e-sbirka.cz/eli/cz/sb/1993/2";
const previousFetch = globalThis.fetch;

const statute = {
  country: "CZE",
  documentType: "ústavní zákon",
  documentUrl: null,
  effectiveDate: "1993-01-01",
  eli: LISTINA_ELI,
  id: "01a02a37-1111-7111-8111-111111111111",
  language: "cs",
  sourceUrl: LISTINA_ELI,
  status: "in_force",
  title: "2/1993 Sb., Listina základních práv a svobod",
  versionValidFrom: "1993-01-01",
  versionValidTo: null,
};

afterEach(() => {
  globalThis.fetch = previousFetch;
});

describe("provision statute resolution", () => {
  test("uses the act-number identity instead of a prefix-truncated ELI search", async () => {
    const requestedUrls: URL[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        requestedUrls.push(url);
        const exactNumber =
          url.searchParams.get("number") === "2/1993" &&
          url.searchParams.get("collection") === "sb";
        return new Response(
          JSON.stringify({
            items: exactNumber
              ? [statute]
              : [
                  {
                    ...statute,
                    eli: "https://www.e-sbirka.cz/eli/cz/sb/1993/20",
                    title: "20/1993 Sb.",
                  },
                ],
            limit: 5,
            nextCursor: null,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
      { preconnect: previousFetch.preconnect },
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const resolved = await queryClient.query(
      statuteByEliOptions({
        asOf: "2011-03-22",
        country: "CZE",
        eli: LISTINA_ELI,
      }),
    );

    expect(resolved?.eli).toBe(LISTINA_ELI);
    expect(requestedUrls.at(0)?.searchParams.get("number")).toBe("2/1993");
    expect(requestedUrls.at(0)?.searchParams.get("collection")).toBe("sb");
    expect(requestedUrls.at(0)?.searchParams.get("asOf")).toBe("2011-03-22");
  });
});
