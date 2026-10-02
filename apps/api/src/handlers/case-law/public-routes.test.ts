import { describe, expect, test } from "bun:test";

import {
  PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_CAPABILITIES,
} from "@stll/api-contract/public-country-capability";

import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";

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
      expect(response.status).toBe(503);
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
      expect(response.status, request.url).toBe(503);
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
