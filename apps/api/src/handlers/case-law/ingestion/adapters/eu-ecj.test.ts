import { Result } from "better-result";
/* eslint-disable typescript-eslint/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import {
  celexToCaseNumber,
  ecjListingIdentity,
  euEcjAdapter as ecjAdapter,
  SPARQL_LIMIT,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { tipWindowSlices } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import {
  listingIdentityKey,
  parseListingIdentityKey,
} from "@/api/lib/legal-search/ingestion-types";
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

/**
 * Budget for a test that parses the fixture judgment. One parse runs for
 * seconds, close enough to the 5s default that such a test fails on load
 * rather than on a defect when the runner schedules another parse-heavy file
 * beside this one. A real hang still ends the run.
 */
const PARSE_TEST_TIMEOUT = { timeout: 30_000 } as const;

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
        `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}`,
      );
      expect(first.sourceUrl).toBe(
        "https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:62021CJ0128",
      );
      expect(first.sourceDocumentId).toBe("62021CJ0128:en");
      // The hint the pipeline re-keys an existing null-id row by: it must be
      // the URL that row carries, which is this result's own `sourceUrl`.
      expect(first.legacySourceUrls).toEqual([first.sourceUrl ?? ""]);
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
      expect(new TextDecoder().decode(first.sourceRawBytes)).toBe(fulltextHtml);
      expect(first.sourceRawContentType).toBe(
        "application/xhtml+xml; stella-storage=verbatim",
      );
      expect(hasUsableAst(first.documentAst)).toBe(true);
      expect(first.sections?.length).toBeGreaterThan(1);
    },
    PARSE_TEST_TIMEOUT,
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

  test(
    "skips languages without fulltext",
    async () => {
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
    },
    PARSE_TEST_TIMEOUT,
  );

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
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}`,
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

// -- Reconciliation --

/**
 * What the standing reconciliation loop drives this source through. Read once
 * here so every test below exercises the capability the adapter actually
 * publishes, not a copy of it.
 */
const reconciliation = requireReconciliation(ecjAdapter);

/**
 * bun-types declares `.rejects.toThrow` as void, so awaiting it trips
 * type-aware lint; capture the rejection explicitly instead.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => null,
    (error: unknown) => error,
  );

const rejectionMessage = (rejection: unknown): string =>
  rejection instanceof Error ? rejection.message : "";

const LANGUAGE_PREFIX =
  "http://publications.europa.eu/resource/authority/language/";

/** The key the engine's held-lookup builds for a stored row: the publisher
 * identity the ingest wrote, exactly the column the decision identity index
 * is keyed on. */
const storedIdentityKey = (decision: {
  sourceDocumentId?: string | undefined;
}): string | null =>
  listingIdentityKey({
    type: "document",
    sourceDocumentId: decision.sourceDocumentId ?? "",
  });

/**
 * Enough text for the adapter to accept the response as a document. These
 * tests are about which variant is keyed, listed and built, so they stay off
 * the parser's own fixture: parsing a real judgment for each of them costs
 * seconds and proves nothing they assert.
 */
const shortDocumentHtml = `<html><body><p>${"Judgment of the Court. ".repeat(
  20,
)}</p></body></html>`;

type SparqlMockOptions = {
  bindings: readonly unknown[];
  /** Manifestation ids Cellar serves a document for. */
  served?: readonly string[];
};

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

/** Queries the mock was asked, so a test can assert the range it listed. */
const installSparqlMock = ({
  bindings,
  served = [],
}: SparqlMockOptions): { queries: string[]; documentFetches: string[] } => {
  const queries: string[] = [];
  const documentFetches: string[] = [];
  globalThis.fetch = asFetchMock(
    mock((input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("sparql")) {
        const body = typeof init?.body === "string" ? init.body : "";
        queries.push(new URLSearchParams(body).get("query") ?? "");
        return Promise.resolve(
          new Response(JSON.stringify({ results: { bindings } }), {
            status: 200,
          }),
        );
      }
      documentFetches.push(url);
      return served.some((id) => url.includes(id))
        ? Promise.resolve(
            new Response(shortDocumentHtml, {
              status: 200,
              headers: { "Content-Type": "text/html" },
            }),
          )
        : Promise.resolve(new Response("Not found", { status: 404 }));
    }),
  );
  return { queries, documentFetches };
};

/**
 * Serve one listed variant whose document response carries the given body and
 * `Content-Type`, so a test can state what the publisher answered with.
 */
const installTypedDocumentMock = (body: string, contentType: string): void => {
  globalThis.fetch = asFetchMock(
    mock((input: string | URL | Request) => {
      if (requestUrl(input).includes("sparql")) {
        return Promise.resolve(
          new Response(JSON.stringify({ results: { bindings: [enBinding] } }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": contentType },
        }),
      );
    }),
  );
};

describe("ecjListingIdentity", () => {
  test("keys a variant on its CELEX and the stored language tag", () => {
    expect(
      ecjListingIdentity({ celex: "62021CJ0128", language: "EN" }),
    ).toEqual({ type: "document", sourceDocumentId: "62021CJ0128:en" });
    expect(
      ecjListingIdentity({ celex: "62023TJ0201", language: "MT" }),
    ).toEqual({ type: "document", sourceDocumentId: "62023TJ0201:mt" });
  });

  test("the key it produces fits the ledger and reads back", () => {
    const identity = ecjListingIdentity({
      celex: "62009FJ0100",
      language: "SV",
    });
    expect(listingIdentityKey(identity)).toBe("document:62009FJ0100:sv");
    expect(parseListingIdentityKey(listingIdentityKey(identity) ?? "")).toEqual(
      identity,
    );
  });

  test("the documents that settle one docket are separate identities", () => {
    // A judgment and an order both numbered C-128/21, in one language: keyed
    // on the docket they were one row and the second replaced the first.
    const judgment = ecjListingIdentity({
      celex: "62021CJ0128",
      language: "EN",
    });
    const order = ecjListingIdentity({ celex: "62021CO0128", language: "EN" });
    expect(celexToCaseNumber("62021CO0128")).toBe(
      celexToCaseNumber("62021CJ0128"),
    );
    expect(listingIdentityKey(order)).not.toBe(listingIdentityKey(judgment));
  });

  test("one document's language variants are separate identities", () => {
    // This source stores a row per language, so a single identity for the
    // work would have each translation overwrite the last.
    expect(
      listingIdentityKey(
        ecjListingIdentity({ celex: "62021CJ0128", language: "FR" }),
      ),
    ).not.toBe(
      listingIdentityKey(
        ecjListingIdentity({ celex: "62021CJ0128", language: "EN" }),
      ),
    );
  });

  test("a CELEX in a format the adapter cannot parse still keys", () => {
    // Only the docket is derived by pattern; the identity is the CELEX the
    // publisher stated, so a sector or type this adapter has no rule for is
    // still one document.
    expect(
      ecjListingIdentity({ celex: "62021XX0128", language: "EN" }),
    ).toEqual({ type: "document", sourceDocumentId: "62021XX0128:en" });
  });

  test("a CELEX no store can hold keys nothing", () => {
    // Reserving it is impossible, so hunting a row under it would keep the
    // slice short for a document nothing can ever write.
    for (const celex of ["", "not a celex", "6".repeat(300)]) {
      expect(ecjListingIdentity({ celex, language: "EN" })).toEqual({
        type: "unidentifiable",
      });
    }
  });
});

describe("euEcjAdapter.reconciliation slices", () => {
  test("a slice is a decision year, and years sort in walk order", () => {
    expect(reconciliation.firstSlice).toBe("1952");
    expect(reconciliation.sliceOf(new Date("2024-06-30T12:00:00.000Z"))).toBe(
      "2024",
    );
    // The boundary is UTC, like every other slice this loop compares.
    expect(reconciliation.sliceOf(new Date("2023-12-31T23:30:00.000Z"))).toBe(
      "2023",
    );
    expect(reconciliation.sliceOf(new Date("2024-01-01T00:30:00.000Z"))).toBe(
      "2024",
    );
  });

  test("the walk steps one year at a time in both directions", () => {
    expect(reconciliation.nextSlice("2023")).toBe("2024");
    expect(reconciliation.previousSlice("2024")).toBe("2023");
    expect(reconciliation.previousSlice(reconciliation.firstSlice)).toBeNull();
    expect(
      reconciliation.nextSlice(reconciliation.sliceOf(new Date())),
    ).toBeNull();
  });

  test("the sweep reaches the Court's first decisions and stops there", () => {
    const walked: string[] = [];
    let cursor: string | null = "1955";
    while (cursor !== null) {
      walked.push(cursor);
      cursor = reconciliation.previousSlice(cursor);
    }
    expect(walked).toEqual(["1955", "1954", "1953", "1952"]);
    // Lexicographic descending is the order the ledger is compared in.
    expect(walked.toSorted().toReversed()).toEqual(walked);
  });

  test("the tip window is the current year and the one before it", () => {
    // `tipWindowDays` counts slices, so with year slices the window is two
    // years, not two days.
    expect(
      tipWindowSlices(reconciliation, new Date("2026-08-11T09:30:00Z")),
    ).toEqual(["2026", "2025"]);
    // A source younger than the window yields only the slices that exist.
    expect(
      tipWindowSlices(reconciliation, new Date("1952-03-04T09:30:00Z")),
    ).toEqual(["1952"]);
  });

  test("a slice that is not a year is refused rather than guessed at", () => {
    expect(() => reconciliation.nextSlice("2024-01")).toThrow(
      "eu-ecj slice is not a four-digit year",
    );
    expect(() => reconciliation.previousSlice("202")).toThrow(
      "eu-ecj slice is not a four-digit year",
    );
  });
});

describe("euEcjAdapter.reconciliation.listSlicePage", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  test("pages a year one calendar month at a time", async () => {
    const { queries } = installSparqlMock({ bindings: [enBinding] });

    const page = await reconciliation.listSlicePage({ slice: "2024", page: 1 });

    expect(page.totalPages).toBe(12);
    // February of a leap year: the range ends on the month's own last day.
    expect(queries.at(0)).toContain('FILTER(STR(?date) >= "2024-02-01")');
    expect(queries.at(0)).toContain('FILTER(STR(?date) <= "2024-02-29")');
  });

  test("the last page covers December", async () => {
    const { queries } = installSparqlMock({ bindings: [] });

    await reconciliation.listSlicePage({ slice: "1998", page: 11 });

    expect(queries.at(0)).toContain('FILTER(STR(?date) >= "1998-12-01")');
    expect(queries.at(0)).toContain('FILTER(STR(?date) <= "1998-12-31")');
  });

  test("lists one item per variant, whatever the manifestations", async () => {
    const republishedEn = withManifestation(firstFixtureBinding, {
      cellarLanguage: "ENG",
      manifestationId: "5f978357-b5e4-11ee-b164-01aa75ed71a1.0002.05",
    });
    const unpublishedLanguage = withManifestation(firstFixtureBinding, {
      cellarLanguage: "ZZZ",
      manifestationId: "5f978357-b5e4-11ee-b164-01aa75ed71a1.0003.05",
    });
    installSparqlMock({
      bindings: [enBinding, republishedEn, frBinding, unpublishedLanguage],
    });

    const page = await reconciliation.listSlicePage({ slice: "2024", page: 0 });

    // The re-published EN manifestation is the same variant, and a language
    // this adapter does not publish is one the crawl would never store.
    expect(
      page.items.map(({ identity }) => listingIdentityKey(identity)),
    ).toEqual(["document:62021CJ0128:en", "document:62021CJ0128:fr"]);
    expect(page.items.map(({ payload }) => payload)).toEqual([
      { celex: "62021CJ0128", language: "EN" },
      { celex: "62021CJ0128", language: "FR" },
    ]);
  });

  test("refuses a listing the endpoint truncated", async () => {
    // A short page banked as a whole slice reads as settled, and the
    // variants the cap left out would be recorded as never published.
    const capped = Array.from({ length: SPARQL_LIMIT }, (_, index) => ({
      ecli: { type: "literal", value: `ECLI:EU:C:2024:${index}` },
      date: { type: "literal", value: "2024-01-18" },
      celex: {
        type: "literal",
        value: `62021CJ${String(index).padStart(4, "0")}`,
      },
      type: {
        type: "uri",
        value: "http://publications.europa.eu/ontology/cdm#judgement",
      },
      language: { type: "uri", value: `${LANGUAGE_PREFIX}ENG` },
      manifestation: {
        type: "uri",
        value: `${CELLAR_RESOURCE_PREFIX}${EN_MANIFESTATION_ID}`,
      },
    }));
    installSparqlMock({ bindings: capped });

    const rejection = await rejectionOf(
      reconciliation.listSlicePage({ slice: "2024", page: 0 }),
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejectionMessage(rejection)).toContain("truncated");
  });

  test("a request that gives up throws rather than shortening the page", async () => {
    // The other half of the truncation rule: an aborted or failed listing
    // must reach the caller as a failure. Answering with the items that did
    // arrive would bank a partial slice as the whole of it.
    globalThis.fetch = asFetchMock(
      mock(() =>
        Promise.reject(
          new DOMException("The operation timed out", "TimeoutError"),
        ),
      ),
    );

    const rejection = await rejectionOf(
      reconciliation.listSlicePage({ slice: "2024", page: 0 }),
    );

    expect(rejection).toBeInstanceOf(DOMException);
  });

  test("keys the documents that settle one docket as separate rows", async () => {
    // An opinion, a judgment and an order can settle one docket. Keyed on the
    // docket they were one identity and one row, so the slice settled with
    // one of them held and the others were never hunted again; keyed on the
    // CELEX the publisher states, each is asked about on its own.
    const orderBinding = {
      ...withManifestation(firstFixtureBinding, {
        cellarLanguage: "ENG",
        manifestationId: "5f978357-b5e4-11ee-b164-01aa75ed71a1.0004.05",
      }),
      celex: { type: "literal", value: "62021CO0128" },
    };
    installSparqlMock({ bindings: [enBinding, orderBinding] });

    const page = await reconciliation.listSlicePage({
      slice: "2024",
      page: 0,
    });

    expect(page.items.map(({ payload }) => payload)).toEqual([
      { celex: "62021CJ0128", language: "EN" },
      { celex: "62021CO0128", language: "EN" },
    ]);
    expect(
      page.items.map(({ identity }) => listingIdentityKey(identity)),
    ).toEqual(["document:62021CJ0128:en", "document:62021CO0128:en"]);
  });

  test("refuses a page the slice does not have", async () => {
    installSparqlMock({ bindings: [] });

    const rejection = await rejectionOf(
      reconciliation.listSlicePage({ slice: "2024", page: 12 }),
    );

    expect(rejectionMessage(rejection)).toContain("slice page out of range");
  });

  test("keys a listed variant exactly as the crawl stores it", async () => {
    // The drift this guards is silent in both directions: key a stored row
    // differently and the loop re-fetches it forever, key a listed item
    // differently and the slice never settles.
    installSparqlMock({
      bindings: [enBinding, frBinding],
      served: [EN_MANIFESTATION_ID, FR_MANIFESTATION_ID],
    });

    const crawled = await ecjAdapter.fetchPage("2024-01-18", {});
    if (!Result.isOk(crawled)) {
      throw new TypeError("Expected Ok result");
    }
    const listed = await reconciliation.listSlicePage({
      slice: "2024",
      page: 0,
    });

    // The premise of the document identity: every row this adapter writes
    // states the publisher identity the walk hunts it by.
    expect(
      crawled.value.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["62021CJ0128:en", "62021CJ0128:fr"]);
    expect(
      listed.items.map(({ identity }) => listingIdentityKey(identity)),
    ).toEqual(crawled.value.decisions.map(storedIdentityKey));
  });
});

describe("euEcjAdapter.reconciliation.buildDecision", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  test("builds the variant a stored payload names", async () => {
    installSparqlMock({
      bindings: [enBinding, frBinding],
      served: [EN_MANIFESTATION_ID, FR_MANIFESTATION_ID],
    });

    // Through JSON, as the loop stores a parked payload and replays it.
    const parked = JSON.stringify({ celex: "62021CJ0128", language: "FR" });
    const payload: unknown = JSON.parse(parked);
    const outcome = await reconciliation.buildDecision(payload);

    if (outcome.type !== "built") {
      throw new TypeError(`Expected built, got ${outcome.type}`);
    }
    expect(outcome.decision.caseNumber).toBe("C-128/21");
    expect(outcome.decision.language).toBe("fr");
    expect(outcome.decision.documentUrl).toContain(FR_MANIFESTATION_ID);
  });

  test("builds from a later manifestation when the first is unreadable", async () => {
    // A work can expose several XHTML manifestations of one language. The
    // crawl treats a variant as done only once one of them builds, so a
    // rebuild that stopped at the first would park — and eventually retire —
    // a document the crawl ingests without trouble.
    const staleManifestation = withManifestation(firstFixtureBinding, {
      cellarLanguage: "ENG",
      manifestationId: "5f978357-b5e4-11ee-b164-01aa75ed71a1.0005.05",
    });
    installSparqlMock({
      bindings: [staleManifestation, enBinding],
      served: [EN_MANIFESTATION_ID],
    });

    const outcome = await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    if (outcome.type !== "built") {
      throw new TypeError(`Expected built, got ${outcome.type}`);
    }
    expect(outcome.decision.documentUrl).toContain(EN_MANIFESTATION_ID);
  });

  test("reports a variant the publisher lists but does not serve", async () => {
    installSparqlMock({ bindings: [enBinding, frBinding], served: [] });

    const outcome = await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    // Not an error and not a written row: the loop parks it, widens its
    // schedule and eventually retires it, which is what settles the slice.
    expect(outcome).toEqual({ type: "detail-unavailable" });
  });

  test("addresses the manifestation itself, not a fixed item ordinal", async () => {
    // `DOC_1` names the manifestation's first item, and the XHTML is not
    // always first: works published before the current item layout expose it
    // at a later ordinal and answer 404 at `DOC_1`. That 404 is indistinguish-
    // able here from a variant the publisher never published, so the loop
    // parked and then permanently retired documents Cellar does serve.
    const { documentFetches } = installSparqlMock({
      bindings: [enBinding],
      served: [EN_MANIFESTATION_ID],
    });

    const outcome = await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    if (outcome.type !== "built") {
      throw new TypeError(`Expected built, got ${outcome.type}`);
    }
    expect(documentFetches).toEqual([
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}`,
    ]);
  });

  /**
   * Serve the manifestation only at one of its numbered items, the way Cellar
   * stores a work whose manifestation resource does not content-negotiate:
   * the manifestation URL answers 404 whatever is asked for, and the document
   * is reachable only under it. Records every request so a test can state
   * which addresses were tried, in order, and with what `Accept`.
   */
  const installItemOnlyMock = (
    servedOrdinal: number,
  ): { fetches: { url: string; accept: string | undefined }[] } => {
    const fetches: { url: string; accept: string | undefined }[] = [];
    globalThis.fetch = asFetchMock(
      mock((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes("sparql")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ results: { bindings: [enBinding] } }),
              { status: 200 },
            ),
          );
        }
        const accept = new Headers(init?.headers).get("accept") ?? undefined;
        fetches.push({ url, accept });
        if (!url.endsWith(`/DOC_${servedOrdinal}`)) {
          return Promise.resolve(new Response("Not found", { status: 404 }));
        }
        // Cellar serves an older item as simplified HTML, and refuses any
        // `Accept` naming a bare type it does not match.
        if (accept !== undefined) {
          return Promise.resolve(new Response("", { status: 406 }));
        }
        return Promise.resolve(
          new Response(shortDocumentHtml, {
            status: 200,
            headers: { "Content-Type": "text/html;type=simplified" },
          }),
        );
      }),
    );
    return { fetches };
  };

  /** Answer every document address with one status, and record the requests. */
  const installStatusMock = (status: number): { fetches: string[] } => {
    const fetches: string[] = [];
    globalThis.fetch = asFetchMock(
      mock((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("sparql")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ results: { bindings: [enBinding] } }),
              {
                status: 200,
              },
            ),
          );
        }
        fetches.push(url);
        return Promise.resolve(new Response("", { status }));
      }),
    );
    return { fetches };
  };

  test("falls back to the manifestation's items when negotiation is refused", async () => {
    // Addressing the manifestation fixed the works whose XHTML sits at a later
    // ordinal, but it is not how Cellar stores all of them: for the rest the
    // manifestation URL answers 404 under negotiation while the document is
    // served under it as an item. Neither addressing scheme covers the corpus,
    // so a variant refused by one has to be tried against the other before it
    // can be called unavailable.
    const { fetches } = installItemOnlyMock(1);

    const outcome = await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    if (outcome.type !== "built") {
      throw new TypeError(`Expected built, got ${outcome.type}`);
    }
    expect(fetches.map(({ url }) => url)).toEqual([
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}`,
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}/DOC_1`,
    ]);
  });

  test("walks past an item ordinal the manifestation does not serve", async () => {
    // The ordinal is no more fixed on this path than it was on the old one:
    // stopping at `DOC_1` would reinstate the same defect one address along.
    const { fetches } = installItemOnlyMock(2);

    const outcome = await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    if (outcome.type !== "built") {
      throw new TypeError(`Expected built, got ${outcome.type}`);
    }
    expect(fetches.at(-1)?.url).toBe(
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}/DOC_2`,
    );
  });

  test("asks an item for no media type in particular", async () => {
    // The negotiated request names XHTML; an item request must not. Cellar
    // serves these items as `text/html;type=simplified` and matches an
    // `Accept` against that whole type, so naming a document type answers 406
    // on precisely the documents this fallback exists to reach.
    const { fetches } = installItemOnlyMock(1);

    await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    // Strict: `toEqual` drops a trailing `undefined`, so it would hold just as
    // well against a single negotiated request that never reached an item.
    expect(fetches.map(({ accept }) => accept)).toStrictEqual([
      "application/xhtml+xml",
      undefined,
    ]);
  });

  test("reports a variant unavailable only once every address has refused", async () => {
    // The distinction the warning carries is only true if it is emitted after
    // both addressing schemes have been tried, not after the first.
    const { fetches } = installItemOnlyMock(0);

    const outcome = await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    expect(outcome).toEqual({ type: "detail-unavailable" });
    expect(fetches.map(({ url }) => url)).toEqual([
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}`,
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}/DOC_1`,
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}/DOC_2`,
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}/DOC_3`,
    ]);
  });

  test.each(
    [401, 403, 408, 429, 500, 502, 503, 504].flatMap((status) =>
      [0, 1, 2].map((ordinal) => ({ status, ordinal })),
    ),
  )(
    "propagates HTTP $status at address $ordinal without further probing",
    async ({ status, ordinal }) => {
      const { fetches } = installItemOnlyMock(0);
      const itemFetch = globalThis.fetch;
      const failedUrl = `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}${ordinal === 0 ? "" : `/DOC_${ordinal}`}`;
      globalThis.fetch = asFetchMock(
        mock((input: string | URL | Request, init?: RequestInit) => {
          if (requestUrl(input) === failedUrl) {
            fetches.push({
              url: failedUrl,
              accept: new Headers(init?.headers).get("accept") ?? undefined,
            });
            return Promise.resolve(new Response("Unavailable", { status }));
          }
          return itemFetch(input, init);
        }),
      );

      const rejection = await rejectionOf(
        reconciliation.buildDecision({
          celex: "62021CJ0128",
          language: "EN",
        }),
      );

      expect(rejectionMessage(rejection)).toContain(
        `CJEU document request failed: ${status}`,
      );
      expect(fetches).toHaveLength(ordinal + 1);
      expect(fetches.at(-1)?.url).toBe(failedUrl);
    },
  );

  test("continues crawling other variants after a deterministic bad document request", async () => {
    const { documentFetches } = installSparqlMock({
      bindings: [enBinding, frBinding],
      served: [FR_MANIFESTATION_ID],
    });
    const servedFetch = globalThis.fetch;
    const rejectedUrl = `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}`;
    globalThis.fetch = asFetchMock(
      mock((input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input) === rejectedUrl) {
          documentFetches.push(rejectedUrl);
          return Promise.resolve(new Response("Bad request", { status: 400 }));
        }
        return servedFetch(input, init);
      }),
    );

    const outcome = await ecjAdapter.fetchPage("2024-01-18", {});

    if (!Result.isOk(outcome)) {
      throw new TypeError("Expected successful crawl page");
    }
    expect(outcome.value.decisions.map(({ language }) => language)).toEqual([
      "fr",
    ]);
    expect(documentFetches).toEqual([
      rejectedUrl,
      `https://publications.europa.eu/resource/cellar/${FR_MANIFESTATION_ID}`,
    ]);
    expect(outcome.value.nextCursor).toBe("2024-01-19");
  });

  test("keeps walking when a refusal means this address cannot serve it", async () => {
    // The counterpart to the test above: 404 is what the item walk exists for,
    // so it must still spend the remaining addresses.
    const { fetches } = installStatusMock(404);

    await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    expect(fetches).toHaveLength(4);
  });

  test("records the address that served the document, not the one it is named by", async () => {
    // An item-only manifestation answers 404 at its own URL, so persisting
    // that as `documentUrl` would publish a link that does not resolve.
    installItemOnlyMock(2);

    const outcome = await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    if (outcome.type !== "built") {
      throw new TypeError(`Expected built, got ${outcome.type}`);
    }
    expect(outcome.decision.documentUrl).toBe(
      `https://publications.europa.eu/resource/cellar/${EN_MANIFESTATION_ID}/DOC_2`,
    );
  });

  test("asks the content stream for XHTML", async () => {
    // The item is chosen by content negotiation now that the URL no longer
    // names one, so the Accept header is what selects the document.
    const accepts: (string | undefined)[] = [];
    globalThis.fetch = asFetchMock(
      mock((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes("sparql")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ results: { bindings: [enBinding] } }),
              {
                status: 200,
              },
            ),
          );
        }
        accepts.push(new Headers(init?.headers).get("accept") ?? undefined);
        return Promise.resolve(
          new Response(shortDocumentHtml, {
            status: 200,
            headers: { "Content-Type": "application/xhtml+xml" },
          }),
        );
      }),
    );

    await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    expect(accepts).toEqual(["application/xhtml+xml"]);
  });

  test("reads the media type whole, not as a substring of the header", async () => {
    // A parameter can carry an allowed type into a header that names something
    // else. This is the exact response the media-type check exists to refuse,
    // so a substring test would accept the one body it must not.
    const rdfBody =
      `<cdm:manifestation_type>xhtml</cdm:manifestation_type>`.repeat(20) +
      `<cdm:work_date_document>2024-01-18</cdm:work_date_document>`.repeat(20);
    installTypedDocumentMock(
      `<?xml version="1.0"?><rdf:RDF>${rdfBody}</rdf:RDF>`,
      'application/rdf+xml; profile="text/html"',
    );

    expect(
      await reconciliation.buildDecision({
        celex: "62021CJ0128",
        language: "EN",
      }),
    ).toEqual({ type: "detail-unavailable" });
  });

  test("accepts the media type in any case the publisher spells it", async () => {
    // The grammar is case-insensitive, so a variant spelling is the same type.
    // Rejecting it would park and eventually retire a document Cellar serves,
    // which is the failure this whole change removes.
    installTypedDocumentMock(shortDocumentHtml, "Application/XHTML+XML");

    const outcome = await reconciliation.buildDecision({
      celex: "62021CJ0128",
      language: "EN",
    });

    expect(outcome.type).toBe("built");
  });

  test("does not read the manifestation's RDF description as the decision", async () => {
    // Unnegotiated, the manifestation URL answers its own RDF description.
    // It is far longer than the minimum document length, so size alone would
    // accept it and store metadata as the decision's text.
    // Cellar's description carries literals, so stripping its tags leaves
    // prose-shaped text: length and tag-stripping both accept it, and only
    // the declared media type says it is not the document.
    const rdfBody =
      `<cdm:manifestation_type>xhtml</cdm:manifestation_type>`.repeat(20) +
      `<cdm:work_date_document>2024-01-18</cdm:work_date_document>`.repeat(20);
    const rdf = `<?xml version="1.0"?><rdf:RDF>${rdfBody}</rdf:RDF>`;
    installTypedDocumentMock(rdf, "application/rdf+xml;charset=UTF-8");

    expect(rdf.length).toBeGreaterThan(100);
    expect(
      await reconciliation.buildDecision({
        celex: "62021CJ0128",
        language: "EN",
      }),
    ).toEqual({ type: "detail-unavailable" });
  });

  test("reports a language the publisher no longer lists", async () => {
    installSparqlMock({
      bindings: [frBinding],
      served: [EN_MANIFESTATION_ID, FR_MANIFESTATION_ID],
    });

    expect(
      await reconciliation.buildDecision({
        celex: "62021CJ0128",
        language: "EN",
      }),
    ).toEqual({ type: "detail-unavailable" });
  });

  test("reports a payload no current identity rule keys", async () => {
    const { queries, documentFetches } = installSparqlMock({ bindings: [] });

    // A payload parked by an older adapter version, or one whose CELEX the
    // query boundary would reject. Retired rather than retried, and the
    // publisher is not contacted about it at all.
    for (const payload of [
      { celex: "62021cj0128", language: "EN" },
      { celex: "62021CJ0128", language: "XX" },
      { celex: "62021CJ0128" },
      "62021CJ0128",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each payload is asserted in turn
      expect(await reconciliation.buildDecision(payload)).toEqual({
        type: "unkeyable",
      });
    }
    expect(queries).toHaveLength(0);
    expect(documentFetches).toHaveLength(0);
  });
});
