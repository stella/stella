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

  test("rejects a portrait request for an unreadable judge id before data access", async () => {
    // Same shape as the cursor case above: the answer arrives before any
    // database or object-store access, so a malformed id never reaches them.
    const response = await publicCaseLawRoute.handle(
      new Request("http://localhost/case/judges/not-a-uuid/portrait"),
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
    // A country the reader resolves and the corpus does not hold: admission,
    // not spelling, so the answer is the same `not found` a missing decision
    // gets. `Germany` states the same thing as a name rather than a code.
    const requests = [
      new Request("http://localhost/case/decisions?country=USA"),
      new Request("http://localhost/case/decisions?country=Germany"),
      new Request("http://localhost/case/decisions/facets?country=USA"),
      new Request("http://localhost/case/decisions/status?country=USA"),
      new Request("http://localhost/case/decisions/latest?country=USA"),
      new Request(
        "http://localhost/case/provisions/citing-decisions?jurisdiction=USA&work=synthetic",
      ),
      new Request(
        "http://localhost/case/sitemap/decisions/shard?country=usa&year=2026&month=01",
      ),
      new Request("http://localhost/case/decisions/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: "USA", query: "synthetic" }),
      }),
    ];

    for (const request of requests) {
      const response = await publicCaseLawRoute.handle(request);
      expect(response.status).toBe(404);
    }
  });

  test("every spelling of one country reaches the same admitted country", async () => {
    // A cursor the route cannot decode, so the answer is reached after the
    // country has been read and admitted and before any data access: the
    // spelling passed if the cursor is what the route complains about.
    const cursor = encodeURIComponent("2026-06-06T00:00:00.000Z_not-a-uuid");

    for (const country of ["CZE", "CZ", "cze", "Česko", "Czech Republic"]) {
      const response = await publicCaseLawRoute.handle(
        new Request(
          `http://localhost/case/decisions?country=${encodeURIComponent(country)}&cursor=${cursor}`,
        ),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "Invalid cursor" });
    }
  });

  test("a country nothing spells names the forms that are accepted", async () => {
    const requests = [
      new Request("http://localhost/case/decisions?country=Freedonia"),
      new Request("http://localhost/case/decisions/facets?country=Freedonia"),
      new Request("http://localhost/case/decisions/status?country=Freedonia"),
      new Request("http://localhost/case/decisions/latest?country=Freedonia"),
      new Request(
        "http://localhost/case/decisions/by-slug/a-case?country=Freedonia",
      ),
      new Request(
        "http://localhost/case/provisions/citing-decisions?jurisdiction=Freedonia&work=synthetic",
      ),
      new Request("http://localhost/case/decisions/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: "Freedonia", query: "synthetic" }),
      }),
    ];

    for (const request of requests) {
      const response = await publicCaseLawRoute.handle(request);

      // The answer is the reader's own ask, so it names the notations
      // ("CZE", the country's name) and the countries there is law for.
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("ISO 3166-1");
      expect(body).toContain("Czechia");
      expect(body).toContain("CZE");
    }
  });
});
