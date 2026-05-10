import { Result } from "better-result";
/* eslint-disable typescript-eslint/no-unsafe-type-assertion */
/* eslint-disable typescript-eslint/promise-function-async */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  ECJ_LANGUAGES,
  celexToCaseNumber,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";

import sparqlFixture from "./__fixtures__/eu-ecj-sparql.json";

const fulltextHtml = await Bun.file(
  new URL("__fixtures__/eu-ecj-fulltext-en.html", import.meta.url),
).text();

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
  const LANG_COUNT = ECJ_LANGUAGES.length;

  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  // TODO: snapshot outdated after SPARQL response format change — update fixture
  test.skip(
    "parses SPARQL + HTML into multi-lang decisions",
    async () => {
      globalThis.fetch = mock((url: string) => {
        const urlStr = url;

        if (urlStr.includes("sparql")) {
          return Promise.resolve(
            new Response(JSON.stringify(sparqlFixture), {
              status: 200,
              headers: {
                "Content-Type": "application/sparql-results+json",
              },
            }),
          );
        }

        if (urlStr.includes("eur-lex.europa.eu")) {
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
      }) as unknown as typeof fetch;

      const { euEcjAdapter } =
        await import("@/api/handlers/case-law/ingestion/adapters/eu-ecj");

      const result = await euEcjAdapter.fetchPage("2024-01-18", {});

      if (!Result.isOk(result)) {
        throw new TypeError("Expected Ok result");
      }
      const page = result.value;

      // 13 real bindings × 24 languages = 312 decisions
      const BINDING_COUNT = sparqlFixture.results.bindings.length;
      expect(page.decisions).toHaveLength(BINDING_COUNT * LANG_COUNT);
      expect(page.nextCursor).toBe("2024-01-19");

      // Verify first binding (C-128/21) produced all languages
      const langs = page.decisions
        .filter((d) => d.caseNumber === "C-128/21")
        .map((d) => d.language)
        .sort();
      expect(langs).toEqual(ECJ_LANGUAGES.map((l) => l.toLowerCase()).sort());

      // Snapshot one representative decision (BG, first lang).
      // Normalize fulltext to a boolean: exact char count varies
      // across platforms due to CRLF/LF line ending differences
      // in the HTML fixture.
      const first = page.decisions[0];
      if (!first) {
        throw new Error("No decisions");
      }
      expect({
        ...first,
        rawHash: "[hash]",
        fulltext: Boolean(first.fulltext),
      }).toMatchSnapshot();
    },
    { timeout: 30_000 },
  );

  test("handles SPARQL error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Server error", { status: 500 })),
    ) as unknown as typeof fetch;

    const { euEcjAdapter } =
      await import("@/api/handlers/case-law/ingestion/adapters/eu-ecj");

    const result = await euEcjAdapter.fetchPage("2024-01-18", {});

    if (!Result.isError(result)) {
      throw new TypeError("Expected Err result");
    }
    expect(result.error.message).toContain("SPARQL error: 500");
  });

  test("handles empty results", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: { bindings: [] },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

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
    globalThis.fetch = mock((url: string) => {
      const urlStr = url;

      if (urlStr.includes("sparql")) {
        const fixture = {
          results: {
            bindings: [sparqlFixture.results.bindings[0]],
          },
        };
        return Promise.resolve(
          new Response(JSON.stringify(fixture), {
            status: 200,
          }),
        );
      }

      // Only EN and FR return fulltext
      if (urlStr.includes("/EN/") || urlStr.includes("/FR/")) {
        return Promise.resolve(
          new Response(fulltextHtml, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
        );
      }

      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as unknown as typeof fetch;

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
    globalThis.fetch = mock((url: string) => {
      const urlStr = url;

      if (urlStr.includes("sparql")) {
        const fixture = {
          results: {
            bindings: [sparqlFixture.results.bindings[0]],
          },
        };
        return Promise.resolve(
          new Response(JSON.stringify(fixture), {
            status: 200,
          }),
        );
      }

      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as unknown as typeof fetch;

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
    globalThis.fetch = mock((url: string) => {
      const urlStr = url;

      if (urlStr.includes("sparql")) {
        const fixture = {
          results: {
            bindings: [sparqlFixture.results.bindings[0]],
          },
        };
        return Promise.resolve(
          new Response(JSON.stringify(fixture), {
            status: 200,
          }),
        );
      }

      // Only EN
      if (urlStr.includes("/EN/")) {
        return Promise.resolve(
          new Response(fulltextHtml, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
        );
      }

      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as unknown as typeof fetch;

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
    expect(d.documentUrl).toContain("/EN/");
  });
});
