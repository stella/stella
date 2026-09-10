import { describe, expect, test } from "bun:test";

import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";

describe("public case-law routes", () => {
  test("rejects invalid public search source IDs before handler execution", async () => {
    const response = await publicCaseLawRoute.handle(
      new Request("http://localhost/case/decisions/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "shareholder dispute",
          country: "CZE",
          sourceId: "not-a-uuid",
        }),
      }),
    );

    expect(response.status).toBe(422);
  });

  test("rejects invalid list cursor IDs before handler execution", async () => {
    const cursor = encodeURIComponent("2026-06-06T00:00:00.000Z_not-a-uuid");
    const response = await publicCaseLawRoute.handle(
      new Request(
        `http://localhost/case/decisions?country=CZE&cursor=${cursor}`,
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Invalid cursor" });
  });

  test("rejects countries outside the public list before data access", async () => {
    const requests = [
      new Request("http://localhost/case/decisions?country=XAA"),
      new Request("http://localhost/case/decisions/facets?country=XAA"),
      new Request("http://localhost/case/decisions/status?country=XAA"),
      new Request("http://localhost/case/decisions/latest?country=XAA"),
      new Request(
        "http://localhost/case/provisions/citing-decisions?jurisdiction=XAA&work=synthetic",
      ),
      new Request(
        "http://localhost/case/sitemap/decisions/shard?country=xaa&year=2026&month=01",
      ),
      new Request("http://localhost/case/decisions/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: "XAA", query: "synthetic" }),
      }),
    ];

    for (const request of requests) {
      const response = await publicCaseLawRoute.handle(request);
      expect(response.status).toBe(404);
    }
  });
});
