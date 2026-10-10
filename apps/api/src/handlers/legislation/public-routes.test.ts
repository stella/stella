import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import {
  PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
} from "@stll/api-contract/public-country-capability";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";
import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { LIMITS } from "@/api/lib/limits";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const readHandlerSource = async (file: string) =>
  await Bun.file(
    nodePath.resolve(repoRoot, `apps/api/src/handlers/legislation/${file}`),
  ).text();

describe("public statute routes", () => {
  test.each(
    PUBLIC_COUNTRIES.filter(
      (country) => PUBLIC_COUNTRY_CAPABILITIES[country] !== "admitted",
    ),
  )(
    "advertised %s reports its capability before reading data",
    async (country) => {
      const urls = [
        `/law/statutes?country=${country}`,
        `/law/sitemap/statutes/shard?country=${country.toLowerCase()}`,
      ];
      for (const url of urls) {
        const response = await publicLegislationRoute.handle(
          new Request(`http://localhost${url}`),
        );
        expect(response.status).toBe(PUBLIC_COUNTRY_UNAVAILABLE_STATUS);
        expect(await response.json()).toMatchObject({
          status: "unavailable",
          country,
          reason: PUBLIC_COUNTRY_CAPABILITIES[country],
        });
      }
    },
  );

  test("pending public countries return typed unavailable for statute search and lookup", async () => {
    const urls = [
      "/law/statutes?country=SVK",
      "/law/statutes/facets?country=SVK",
      "/law/statutes/by-slug/2012-89?country=SVK",
      "/law/sitemap/statutes/shard?country=svk",
    ];
    const requests = urls.map((url) => new Request(`http://localhost${url}`));
    const search = await searchLegislationHandler(
      { jurisdiction: "SVK", query: "synthetic" },
      () => panic("Unavailable country must not reach the database"),
      "unobserved",
    );
    expect(search).toMatchObject({
      code: PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
      response: {
        status: "unavailable",
        country: "SVK",
        reason: "pending_public",
      },
    });
    for (const request of requests) {
      const response = await publicLegislationRoute.handle(request);
      expect(response.status, request.url).toBe(
        PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
      );
      expect(await response.json()).toMatchObject({
        status: "unavailable",
        country: "SVK",
        reason: "pending_public",
      });
    }
  });

  test("serves nothing while the public-law feature is off", async () => {
    const previousFeature = env.FEATURE_PUBLIC_LAW;
    const restoreRuntimeMode = setRuntimeModeForTesting({
      mode: RUNTIME_MODE.strict,
    });
    env.FEATURE_PUBLIC_LAW = false;

    try {
      const absent = await publicLegislationRoute.handle(
        new Request("http://localhost/law/absent-route"),
      );
      const absentBody = await absent.text();
      for (const path of [
        "/law/statutes?country=CZE",
        "/law/statutes/search?country=CZE&query=text",
        // Malformed input must not reach validation and answer 422.
        "/law/statutes/search",
      ]) {
        const response = await publicLegislationRoute.handle(
          new Request(`http://localhost${path}`),
        );
        // A disabled public surface is indistinguishable from an absent route.
        expect(
          { status: response.status, body: await response.text() },
          path,
        ).toEqual({ status: absent.status, body: absentBody });
      }
    } finally {
      restoreRuntimeMode();
      env.FEATURE_PUBLIC_LAW = previousFeature;
    }
  });

  test("rejects a document id that is not a UUID before handler execution", async () => {
    const response = await publicLegislationRoute.handle(
      new Request("http://localhost/law/statutes/not-a-uuid"),
    );

    expect(response.status).toBe(422);
  });

  test("requires the country a statute listing is scoped to", async () => {
    const response = await publicLegislationRoute.handle(
      new Request("http://localhost/law/statutes"),
    );

    expect(response.status).toBe(422);
  });

  test("rejects a point-in-time read with no identifier", async () => {
    const response = await publicLegislationRoute.handle(
      new Request("http://localhost/law/statutes/by-eli"),
    );

    expect(response.status).toBe(422);
  });

  test("rejects an asOf that is not a calendar date", async () => {
    const response = await publicLegislationRoute.handle(
      new Request(
        "http://localhost/law/statutes/by-eli?eli=CZ%2F2012%2F89&asOf=yesterday",
      ),
    );

    expect(response.status).toBe(422);
  });

  test("rejects a resolve batch past its limit before handler execution", async () => {
    const work = { country: "CZE", eli: "CZ/2012/89", asOf: "2021-01-01" };
    const response = await publicLegislationRoute.handle(
      new Request("http://localhost/law/statutes/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          works: Array.from(
            { length: LIMITS.legislationResolveWorksMax + 1 },
            () => work,
          ),
        }),
      }),
    );

    expect(response.status).toBe(422);
  });

  test("reads `by-slug` as its own route, not as a document id", async () => {
    // Without the ordering in the route file, the literal segment lands on
    // `/statutes/:documentId` and the UUID schema answers 422 instead.
    const response = await publicLegislationRoute.handle(
      new Request("http://localhost/law/statutes/by-slug/89-2012-sb"),
    );

    // No country: the resolver's own schema rejects it, so the request did
    // reach the by-slug route.
    expect(response.status).toBe(422);
  });

  test("rejects a slug read with an asOf that is not a calendar date", async () => {
    const response = await publicLegislationRoute.handle(
      new Request(
        "http://localhost/law/statutes/by-slug/89-2012-sb?country=CZE&asOf=yesterday",
      ),
    );

    expect(response.status).toBe(422);
  });

  test("rejects a slug longer than the column can hold", async () => {
    const response = await publicLegislationRoute.handle(
      new Request(
        `http://localhost/law/statutes/by-slug/${"a".repeat(257)}?country=CZE`,
      ),
    );

    expect(response.status).toBe(422);
  });

  test("rejects a provision-history anchor on a non-UUID document", async () => {
    const response = await publicLegislationRoute.handle(
      new Request(
        "http://localhost/law/statutes/not-a-uuid/provisions/p-1/history",
      ),
    );

    expect(response.status).toBe(422);
  });

  test("rejects a list cursor that is not a title/id pair", async () => {
    const response = await publicLegislationRoute.handle(
      new Request(
        "http://localhost/law/statutes?country=CZE&cursor=not-a-cursor",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Invalid cursor" });
  });

  test("every spelling of one country reaches the same statute jurisdiction", async () => {
    // The undecodable cursor is answered after the country has been read and
    // before any data access, so a complaint about the cursor is the proof
    // that the spelling itself was read.
    for (const country of ["CZE", "CZ", "cze", "Česko", "Czech Republic"]) {
      const response = await publicLegislationRoute.handle(
        new Request(
          `http://localhost/law/statutes?country=${encodeURIComponent(country)}&cursor=not-a-cursor`,
        ),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "Invalid cursor" });
    }
  });

  test("a country nothing spells names the forms that are accepted", async () => {
    const urls = [
      "http://localhost/law/statutes?country=Freedonia",
      "http://localhost/law/statutes/shelf?country=Freedonia",
      "http://localhost/law/statutes/by-slug/89-2012-sb?country=Freedonia",
    ];

    for (const url of urls) {
      const response = await publicLegislationRoute.handle(new Request(url));

      // The reader's own ask, so it names both notations and the
      // jurisdictions this deployment holds statutes for.
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("ISO 3166-1");
      expect(body).toContain("Czechia");
      expect(body).toContain("CZE");
    }
  });

  test("authenticated corpus reads use the shared public-law boundary", async () => {
    const [getSource, searchSource] = await Promise.all([
      readHandlerSource("get.ts"),
      readHandlerSource("search.ts"),
    ]);
    const getWrapper = getSource.slice(
      getSource.indexOf("const readLegislation = createSafeRootHandler"),
    );
    const searchWrapper = searchSource.slice(
      searchSource.indexOf("const searchLegislation = createSafeRootHandler"),
    );

    expect(getWrapper).toContain("readPublicLegislationHandler(");
    expect(getWrapper).toContain("legislationPublicReadDb");
    expect(getWrapper).not.toContain("scopedDb");
    expect(searchWrapper).toContain("searchLegislationHandler(");
    expect(searchWrapper).toContain("legislationPublicReadDb");
    expect(searchWrapper).not.toContain("scopedDb");
  });

  test("public full-text search retains the shared redistribution boundary", async () => {
    const source = await readHandlerSource("public-search.ts");
    expect(source).toContain("searchLegislationHandler");
    expect(source).toContain("legislationPublicReadDb");
    expect(source).not.toContain("scopedDb");
    expect(source).not.toContain("loadSearchConfigs:");
    const response = await publicLegislationRoute.handle(
      new Request(
        "http://localhost/law/statutes/search?country=CZE&query=text&cursor=invalid-cursor",
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Invalid cursor" });
  });
});
