import { Result } from "better-result";
/* eslint-disable typescript-eslint/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import { celexToCaseNumber } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import sparqlFixture from "./__fixtures__/eu-ecj-sparql.json";

const fulltextHtml = await Bun.file(
  new URL("__fixtures__/eu-ecj-fulltext-en.html", import.meta.url),
).text();

const CELLAR_RESOURCE_PREFIX = "http://publications.europa.eu/resource/cellar/";
const EN_MANIFESTATION_ID = "5980acd6-b5e4-11ee-b164-01aa75ed71a1.0011.05";
const FR_MANIFESTATION_ID = "5980acd6-b5e4-11ee-b164-01aa75ed71a1.0012.05";
const DE_MANIFESTATION_ID = "5980acd6-b5e4-11ee-b164-01aa75ed71a1.0013.05";

type SparqlFixtureBinding = (typeof sparqlFixture.results.bindings)[number];

type WithManifestationOptions = {
  cellarLanguage: string;
  manifestationId: string;
};

const withManifestation = (
  binding: SparqlFixtureBinding,
  { cellarLanguage, manifestationId }: WithManifestationOptions,
) => ({
  ...binding,
  language: {
    type: "uri",
    value: `http://publications.europa.eu/resource/authority/language/${cellarLanguage}`,
  },
  manifestation: {
    type: "uri",
    value: `${CELLAR_RESOURCE_PREFIX}${manifestationId}`,
  },
});

const firstFixtureBinding = sparqlFixture.results.bindings.at(0);
const secondFixtureBinding = sparqlFixture.results.bindings.at(1);
if (!firstFixtureBinding || !secondFixtureBinding) {
  throw new TypeError("Expected at least two CJEU SPARQL fixture bindings");
}

const enBinding = withManifestation(firstFixtureBinding, {
  cellarLanguage: "ENG",
  manifestationId: EN_MANIFESTATION_ID,
});
const frBinding = withManifestation(firstFixtureBinding, {
  cellarLanguage: "FRA",
  manifestationId: FR_MANIFESTATION_ID,
});
const deBinding = withManifestation(firstFixtureBinding, {
  cellarLanguage: "DEU",
  manifestationId: DE_MANIFESTATION_ID,
});

// -- celexToCaseNumber --

describe("celexToCaseNumber", () => {
  test("CJ prefix → C-number/year", () => {
    expect(celexToCaseNumber("62024CJ0436")).toBe("C-436/24");
  });

  test("TJ prefix → T-number/year", () => {
    expect(celexToCaseNumber("62023TJ0201")).toBe("T-201/23");
  });

  test("CC prefix → C-number/year", () => {
    expect(celexToCaseNumber("62023CC0100")).toBe("C-100/23");
  });

  test("CO prefix → C-number/year (order)", () => {
    expect(celexToCaseNumber("62024CO0050")).toBe("C-50/24");
  });

  test("TO prefix → T-number/year", () => {
    expect(celexToCaseNumber("62024TO0012")).toBe("T-12/24");
  });

  test("FJ prefix → F-number/year (Civil Service Tribunal)", () => {
    expect(celexToCaseNumber("62009FJ0100")).toBe("F-100/09");
  });

  test("strips leading zeros from case number", () => {
    expect(celexToCaseNumber("62024CJ0007")).toBe("C-7/24");
  });

  test("returns raw celex for unrecognised format", () => {
    expect(celexToCaseNumber("32024R0001")).toBe("32024R0001");
    expect(celexToCaseNumber("invalid")).toBe("invalid");
  });
});

// -- fetchPage snapshot --

describe("euEcjAdapter.fetchPage", () => {
  const originalFetch = globalThis.fetch;

  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  test(
    "parses SPARQL + HTML into multi-lang decisions",
    async () => {
      const secondDecision = withManifestation(
        {
          ...secondFixtureBinding,
          type: {
            type: "uri",
            value: "http://publications.europa.eu/ontology/cdm#order_cjeu",
          },
        },
        {
          cellarLanguage: "ENG",
          manifestationId: "5f978357-b5e4-11ee-b164-01aa75ed71a1.0001.05",
        },
      );
      const duplicateEnBinding = withManifestation(firstFixtureBinding, {
        cellarLanguage: "ENG",
        manifestationId: "5f978357-b5e4-11ee-b164-01aa75ed71a1.0002.05",
      });
      const bindings = [
        enBinding,
        duplicateEnBinding,
        frBinding,
        secondDecision,
      ];
      globalThis.fetch = asFetchMock(
        mock((url: string) => {
          const urlStr = url;

          if (urlStr.includes("sparql")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  results: { bindings },
                }),
                {
                  status: 200,
                  headers: {
                    "Content-Type": "application/sparql-results+json",
                  },
                },
              ),
            );
          }

          if (urlStr.includes("publications.europa.eu/resource/cellar/")) {
            return Promise.resolve(
              new Response(fulltextHtml, {
                status: 200,
                headers: {
                  "Content-Type": "text/html",
                },
              }),
            );
          }

          return Promise.resolve(new Response("Not found", { status: 404 }));
        }),
      );

      const { euEcjAdapter } =
        await import("@/api/handlers/case-law/ingestion/adapters/eu-ecj");

      const result = await euEcjAdapter.fetchPage("2024-01-18", {});

      if (!Result.isOk(result)) {
        throw new TypeError("Expected Ok result");
      }
      const page = result.value;

      expect(page.decisions).toHaveLength(3);
      expect(page.nextCursor).toBe("2024-01-19");

      // Verify the two discovered manifestations for C-128/21.
      const langs = page.decisions
        .filter((d) => d.caseNumber === "C-128/21")
        .map((d) => d.language)
        .sort();
      expect(langs).toEqual(["en", "fr"]);

      const first = page.decisions[0];
      if (!first) {
        throw new Error("No decisions");
      }
      expect(first.caseNumber).toBe("C-128/21");
      expect(first.ecli).toBe("ECLI:EU:C:2024:49");
      expect(first.court).toBe("Court of Justice");
      expect(first.language).toBe("en");
      expect(first.decisionDate).toBe("2024-01-18");
      expect(first.decisionType).toBe("judgment");
      expect(first.documentUrl).toBe(
        `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}/DOC_1`,
      );
      expect(first.sourceUrl).toBe(
        "https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:62021CJ0128",
      );
      expect(first.metadata).toMatchObject({
        celex: "62021CJ0128",
        ecli: "ECLI:EU:C:2024:49",
        decisionDate: "2024-01-18",
        decisionType: "judgment",
      });
      expect(first.fulltext?.length).toBeGreaterThan(100);
      expect(first.rawHash).toHaveLength(64);
      expect(page.decisions[2]?.decisionType).toBe("order");

      // The XHTML is kept verbatim so a parser change can be replayed
      // without re-crawling, and the parse feeds the reader directly.
      expect(first.sourceRaw).toBe(fulltextHtml);
      expect(first.sourceRawContentType).toBe("application/xhtml+xml");
      expect(hasUsableAst(first.documentAst)).toBe(true);
      expect(first.sections?.length).toBeGreaterThan(1);
    },
    { timeout: 30_000 },
  );

  test("handles SPARQL error", async () => {
    globalThis.fetch = asFetchMock(
      mock(() =>
        Promise.resolve(new Response("Server error", { status: 500 })),
      ),
    );

    const { euEcjAdapter } =
      await import("@/api/handlers/case-law/ingestion/adapters/eu-ecj");

    const result = await euEcjAdapter.fetchPage("2024-01-18", {});

    if (!Result.isError(result)) {
      throw new TypeError("Expected Err result");
    }
    expect(result.error.message).toContain("SPARQL error: 500");
  });

  test("handles empty results", async () => {
    globalThis.fetch = asFetchMock(
      mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              results: { bindings: [] },
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const { euEcjAdapter } =
      await import("@/api/handlers/case-law/ingestion/adapters/eu-ecj");

    const result = await euEcjAdapter.fetchPage("2024-01-18", {});

    if (!Result.isOk(result)) {
      throw new TypeError("Expected Ok result");
    }
    const page = result.value;
    expect(page.decisions).toHaveLength(0);
    expect(page.nextCursor).toBe("2024-01-19");
  });

  test("skips languages without fulltext", async () => {
    globalThis.fetch = asFetchMock(
      mock((url: string) => {
        const urlStr = url;

        if (urlStr.includes("sparql")) {
          const fixture = {
            results: {
              bindings: [enBinding, frBinding, deBinding],
            },
          };
          return Promise.resolve(
            new Response(JSON.stringify(fixture), {
              status: 200,
            }),
          );
        }

        // Only the EN and FR Cellar manifestations return fulltext.
        if (
          urlStr.includes(EN_MANIFESTATION_ID) ||
          urlStr.includes(FR_MANIFESTATION_ID)
        ) {
          return Promise.resolve(
            new Response(fulltextHtml, {
              status: 200,
              headers: { "Content-Type": "text/html" },
            }),
          );
        }

        return Promise.resolve(new Response("Not found", { status: 404 }));
      }),
    );

    const { euEcjAdapter } =
      await import("@/api/handlers/case-law/ingestion/adapters/eu-ecj");

    const result = await euEcjAdapter.fetchPage("2024-01-18", {});

    if (!Result.isOk(result)) {
      throw new TypeError("Expected Ok result");
    }
    const page = result.value;

    // Only EN and FR variants
    expect(page.decisions).toHaveLength(2);
    const langs = page.decisions.map((d) => d.language).sort();
    expect(langs).toEqual(["en", "fr"]);
  });

  test("no decisions when all languages 404", async () => {
    globalThis.fetch = asFetchMock(
      mock((url: string) => {
        const urlStr = url;

        if (urlStr.includes("sparql")) {
          const fixture = {
            results: {
              bindings: [enBinding],
            },
          };
          return Promise.resolve(
            new Response(JSON.stringify(fixture), {
              status: 200,
            }),
          );
        }

        return Promise.resolve(new Response("Not found", { status: 404 }));
      }),
    );

    const { euEcjAdapter } =
      await import("@/api/handlers/case-law/ingestion/adapters/eu-ecj");

    const result = await euEcjAdapter.fetchPage("2024-01-18", {});

    if (!Result.isOk(result)) {
      throw new TypeError("Expected Ok result");
    }
    const page = result.value;
    expect(page.decisions).toHaveLength(0);
  });

  test("language appears in URLs", async () => {
    globalThis.fetch = asFetchMock(
      mock((url: string) => {
        const urlStr = url;

        if (urlStr.includes("sparql")) {
          const fixture = {
            results: {
              bindings: [enBinding],
            },
          };
          return Promise.resolve(
            new Response(JSON.stringify(fixture), {
              status: 200,
            }),
          );
        }

        if (urlStr.includes(EN_MANIFESTATION_ID)) {
          return Promise.resolve(
            new Response(fulltextHtml, {
              status: 200,
              headers: { "Content-Type": "text/html" },
            }),
          );
        }

        return Promise.resolve(new Response("Not found", { status: 404 }));
      }),
    );

    const { euEcjAdapter } =
      await import("@/api/handlers/case-law/ingestion/adapters/eu-ecj");

    const result = await euEcjAdapter.fetchPage("2024-01-18", {});

    if (!Result.isOk(result)) {
      throw new TypeError("Expected Ok result");
    }
    const d = result.value.decisions[0];
    if (!d) {
      throw new Error("No decisions");
    }
    expect(d.language).toBe("en");
    expect(d.sourceUrl).toContain("/EN/");
    expect(d.documentUrl).toBe(
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}/DOC_1`,
    );
  });

  test("rejects a manifestation URL outside the Cellar origin", async () => {
    let externalFetches = 0;
    globalThis.fetch = asFetchMock(
      mock((url: string) => {
        if (url.includes("sparql")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: {
                  bindings: [
                    {
                      ...enBinding,
                      manifestation: {
                        type: "uri",
                        value: "https://attacker.example/document",
                      },
                    },
                  ],
                },
              }),
              { status: 200 },
            ),
          );
        }
        externalFetches += 1;
        return Promise.resolve(new Response(fulltextHtml, { status: 200 }));
      }),
    );

    const { euEcjAdapter } =
      await import("@/api/handlers/case-law/ingestion/adapters/eu-ecj");
    const result = await euEcjAdapter.fetchPage("2024-01-18", {});

    if (!Result.isOk(result)) {
      throw new TypeError("Expected Ok result");
    }
    expect(result.value.decisions).toHaveLength(0);
    expect(externalFetches).toBe(0);
  });
});
