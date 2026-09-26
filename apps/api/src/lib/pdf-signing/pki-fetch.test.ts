import { describe, expect, test } from "bun:test";

import { withFetchBudget } from "@/api/lib/pdf-signing/pki-fetch";
import type { PkiFetcher } from "@/api/lib/pdf-signing/pki-fetch";

describe("bounding PKI fetches", () => {
  test("stops fetching once the budget is spent", async () => {
    let clock = 1000;
    const fetched: string[] = [];
    const fetcher: PkiFetcher = async ({ url }) => {
      fetched.push(url);
      return new Uint8Array([1]);
    };
    const budgeted = withFetchBudget(fetcher, 500, () => clock);

    expect(
      await budgeted({ maxBytes: 1, method: "GET", url: "http://a.example" }),
    ).toEqual(new Uint8Array([1]));
    clock = 1500;
    expect(
      await budgeted({ maxBytes: 1, method: "GET", url: "http://b.example" }),
    ).toBe(null);
    expect(fetched).toEqual(["http://a.example"]);
  });
});
