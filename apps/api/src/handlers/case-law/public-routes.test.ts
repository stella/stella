import { describe, expect, test } from "bun:test";

import {
  PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
} from "@stll/api-contract/public-country-capability";

import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";
import {
  DECISION_PAGE_BEYOND_DEPTH_MESSAGE,
  DECISION_PAGE_CURSOR_AND_OFFSET_MESSAGE,
} from "@/api/lib/case-law/decision-page-offset";
import { LIMITS } from "@/api/lib/limits";

describe("public case-law routes", () => {
  test.each(
    PUBLIC_COUNTRIES.filter(
      (country) => PUBLIC_COUNTRY_CAPABILITIES[country] !== "admitted",
    ),
  )(
    "advertised %s reports its capability before reading data",
    async (country) => {
      const response = await publicCaseLawRoute.handle(
        new Request(`http://localhost/case/decisions?country=${country}`),
      );
      expect(response.status).toBe(PUBLIC_COUNTRY_UNAVAILABLE_STATUS);
      expect(await response.json()).toMatchObject({
        status: "unavailable",
        country,
        reason: PUBLIC_COUNTRY_CAPABILITIES[country],
      });
    },
  );

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

  describe("a page addressed by offset stays within the result depth", () => {
    const search = async (body: Record<string, unknown>) =>
      await publicCaseLawRoute.handle(
        new Request("http://localhost/case/decisions/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "náhrada škody",
            country: "CZE",
            ...body,
          }),
        }),
      );
    const list = async (query: string) =>
      await publicCaseLawRoute.handle(
        new Request(`http://localhost/case/decisions?country=CZE&${query}`),
      );
    // The deepest page a 25-row page size reaches ends exactly on the bound,
    // so one more row is the first request past it.
    const lastPageOffset = LIMITS.caseLawResultDepthMax - 25;

    test("a search page past the deepest result is refused before any read", async () => {
      const response = await search({ limit: 25, offset: lastPageOffset + 1 });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: DECISION_PAGE_BEYOND_DEPTH_MESSAGE,
      });
    });

    test("a browse page past the deepest result is refused before any read", async () => {
      const response = await list(`limit=25&offset=${lastPageOffset + 1}`);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: DECISION_PAGE_BEYOND_DEPTH_MESSAGE,
      });
    });

    test("an offset at or past the depth is not a valid request at all", async () => {
      const searched = await search({ offset: LIMITS.caseLawResultDepthMax });
      const listed = await list(`offset=${LIMITS.caseLawResultDepthMax}`);

      expect(searched.status).toBe(422);
      expect(listed.status).toBe(422);
    });

    test("a page cannot be placed by a cursor and an offset at once", async () => {
      const searched = await search({ cursor: "c2NvcmU6aWQ", offset: 25 });
      const listed = await list("cursor=c2NvcmU6aWQ&offset=25");

      expect([searched.status, listed.status]).toEqual([400, 400]);
      expect([await searched.json(), await listed.json()]).toEqual([
        { message: DECISION_PAGE_CURSOR_AND_OFFSET_MESSAGE },
        { message: DECISION_PAGE_CURSOR_AND_OFFSET_MESSAGE },
      ]);
    });
  });

  test("pending public countries return typed unavailable on every country-addressed route", async () => {
    const urls = [
      "/case/decisions?country=SVK",
      "/case/decisions/facets?country=SVK",
      "/case/decisions/status?country=SVK",
      "/case/decisions/latest?country=SVK",
      "/case/decisions/by-slug/a-case?country=SVK",
      "/case/provisions/citing-decisions?jurisdiction=SVK&work=synthetic",
      "/case/provisions/citation-counts?jurisdiction=SVK&eli=SK/2012/89",
      "/case/sitemap/decisions/shard?country=svk&year=2026&month=01",
    ];
    const requests = urls.map((url) => new Request(`http://localhost${url}`));
    requests.push(
      new Request("http://localhost/case/decisions/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: "SVK", query: "synthetic" }),
      }),
    );
    for (const request of requests) {
      const response = await publicCaseLawRoute.handle(request);
      expect(response.status, request.url).toBe(
        PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
      );
      expect(await response.json()).toMatchObject({
        status: "unavailable",
        country: "SVK",
        reason: "pending_public",
        code: "public_country_unavailable",
      });
    }
  });

  test("unadvertised countries remain a miss", async () => {
    const response = await publicCaseLawRoute.handle(
      new Request("http://localhost/case/decisions?country=Germany"),
    );
    expect(response.status).toBe(404);
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
