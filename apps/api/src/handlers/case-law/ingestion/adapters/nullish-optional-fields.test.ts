import { afterEach, describe, expect, test } from "bun:test";

import { clearRootDbMocks } from "@/api/tests/helpers/mock-root-db";

const { atCourtsAdapter } =
  await import("@/api/handlers/case-law/ingestion/adapters/at-courts");
const { czNsAdapter } =
  await import("@/api/handlers/case-law/ingestion/adapters/cz-ns");
const { czRegionalAdapter } =
  await import("@/api/handlers/case-law/ingestion/adapters/cz-regional");
const { plCourtsAdapter } =
  await import("@/api/handlers/case-law/ingestion/adapters/pl-courts");
const { skCourtsAdapter } =
  await import("@/api/handlers/case-law/ingestion/adapters/sk-courts");

const originalFetch = globalThis.fetch;

type MockRoute = {
  pattern: string;
  body: string;
  status?: number | undefined;
  contentType?: string | undefined;
};

const mockFetchWithBodies = (routes: MockRoute[]) => {
  const mockedFetch: typeof fetch = Object.assign(
    async (input: string | URL | Request): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      const match = routes
        .filter((route) => url.includes(route.pattern))
        .toSorted((left, right) => right.pattern.length - left.pattern.length)
        .at(0);

      if (!match) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(match.body, {
        status: match.status ?? 200,
        headers: {
          "Content-Type": match.contentType ?? "application/json",
        },
      });
    },
    {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    },
  );

  globalThis.fetch = mockedFetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRootDbMocks();
});

describe("case-law adapter nullish optionals", () => {
  test("AT Courts accepts null nested optional metadata lists", async () => {
    mockFetchWithBodies([
      {
        pattern: "/Judikatur?",
        body: JSON.stringify({
          OgdSearchResult: {
            OgdDocumentResults: {
              Hits: {
                "@pageNumber": "1",
                "@pageSize": "20",
                "#text": "1",
              },
              OgdDocumentReference: {
                Data: {
                  Metadaten: {
                    Technisch: {
                      ID: "RIS-1",
                      Applikation: null,
                      Organ: "OGH",
                    },
                    Allgemein: {
                      Veroeffentlicht: null,
                      Geaendert: null,
                      DokumentUrl: "https://ris.example/doc/1",
                    },
                    Judikatur: {
                      Dokumenttyp: "Judgment",
                      Geschaeftszahl: { item: "1 Ob 2/24d" },
                      Normen: { item: null },
                      Entscheidungsdatum: "2024-01-02",
                      EuropeanCaseLawIdentifier: "ECLI:AT:OGH:2024:TEST",
                      Justiz: {
                        Gericht: "OGH",
                        Rechtsgebiete: { item: null },
                        Rechtssatznummern: { item: null },
                        Entscheidungstexte: { item: null },
                      },
                    },
                  },
                  Dokumentliste: {
                    ContentReference: {
                      Urls: {
                        ContentUrl: null,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      },
    ]);

    const result = await atCourtsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    const decision = result.unwrap().decisions[0];
    expect(decision?.caseNumber).toBe("1 Ob 2/24d");
    expect(decision?.metadata).toMatchObject({
      normen: [],
      rechtsgebiete: [],
    });
  });

  test("CZ NS accepts a null viewentry list as an empty page", async () => {
    mockFetchWithBodies([
      {
        pattern: "ReadViewEntries",
        body: JSON.stringify({
          "@toplevelentries": "0",
          viewentry: null,
        }),
      },
    ]);

    const result = await czNsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().decisions).toEqual([]);
  });

  test("CZ Regional accepts null finaldoc arrays and keeps fulltext enrichment", async () => {
    mockFetchWithBodies([
      {
        pattern: "/opendata/",
        body: JSON.stringify({
          items: [
            {
              jednaciCislo: "15 Co 1/2024",
              soud: "Krajsky soud v Brne",
              datumVydani: "2024-03-05",
              odkaz: "https://rozhodnuti.justice.cz/api/finaldoc/test-1",
            },
          ],
          totalPages: 1,
          pageNumber: 0,
        }),
      },
      {
        pattern: "/finaldoc/test-1",
        body: JSON.stringify({
          verdictText: "Vyrok",
          justificationText: "Oduvodneni",
          header: null,
          verdict: null,
          justification: null,
          information: null,
          styles: null,
          metadata: null,
        }),
      },
    ]);

    const result = await czRegionalAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    const decision = result.unwrap().decisions[0];
    expect(decision?.caseNumber).toBe("15 Co 1/2024");
    expect(decision?.fulltext).toContain("Vyrok");
    expect(decision?.sourceRaw).toContain('"verdictText":"Vyrok"');
  });

  test("PL Courts accepts null optional detail fields and maps local decision type", async () => {
    mockFetchWithBodies([
      {
        pattern: "/api/dump/judgments",
        body: JSON.stringify({
          items: [
            {
              id: 1,
              courtType: "COMMON",
              courtCases: [{ caseNumber: "II AKa 10/24" }],
              judgmentType: "SENTENCE",
              judgmentDate: "3024-01-02",
              judges: null,
              keywords: null,
              division: null,
              source: null,
              ecli: "ECLI:PL:TEST",
            },
          ],
        }),
      },
      {
        pattern: "/api/judgments/1",
        body: JSON.stringify({
          data: {
            id: 1,
            courtType: "COMMON",
            courtCases: [{ caseNumber: "II AKa 10/24" }],
            judgmentType: "SENTENCE",
            judgmentDate: "3024-01-02",
            textContent:
              "<p>Sygn. akt II AKa 10/24</p><h2>WYROK</h2>" +
              "<p>Dnia 2 stycznia 2024 r.</p><h2>UZASADNIENIE</h2>" +
              "<p>Treść uzasadnienia.</p>",
            keywords: null,
            division: {
              id: 11,
              name: "II Wydział Karny",
              court: {
                id: 22,
                name: "Sąd Apelacyjny w Krakowie",
              },
            },
            source: {
              judgmentUrl: "https://orzeczenia.ms.gov.pl/example",
              judgmentId: "judgment-1",
            },
            ecli: "ECLI:PL:TEST",
            courtReporters: null,
            decision: null,
            summary: null,
            legalBases: null,
            referencedRegulations: null,
            referencedCourtCases: null,
            receiptDate: null,
            meansOfAppeal: null,
            judgmentResult: null,
            lowerCourtJudgments: null,
            dissentingOpinions: [],
          },
        }),
      },
    ]);

    const result = await plCourtsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    const decision = result.unwrap().decisions[0];
    expect(decision?.caseNumber).toBe("II AKa 10/24");
    expect(decision?.court).toBe("Sąd Apelacyjny w Krakowie");
    expect(decision?.decisionType).toBe("wyrok");
    expect(decision?.decisionDate).toBe("2024-01-02");
    expect(decision?.metadata).toMatchObject({
      dissentingOpinions: [],
    });
    expect(decision?.sourceRaw).toContain('"dumpItem"');
    expect(decision?.sourceRaw).toContain('"detail"');
  });

  test("PL Courts localizes fallback court names when detail court is missing", async () => {
    mockFetchWithBodies([
      {
        pattern: "/api/dump/judgments",
        body: JSON.stringify({
          items: [
            {
              id: 2,
              courtType: "CONSTITUTIONAL_TRIBUNAL",
              courtCases: [{ caseNumber: "U 1/86" }],
              judgmentType: "DECISION",
              judgmentDate: "1986-01-03",
            },
          ],
        }),
      },
      {
        pattern: "/api/judgments/2",
        body: JSON.stringify({
          data: {
            id: 2,
            courtType: "CONSTITUTIONAL_TRIBUNAL",
            courtCases: [{ caseNumber: "U 1/86" }],
            judgmentType: "DECISION",
            judgmentDate: "1986-01-03",
            textContent:
              "Postanowienie\n\nSygn. akt U 1/86\n\npostanawia:\n\numorzyć postępowanie.",
          },
        }),
      },
    ]);

    const result = await plCourtsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    const decision = result.unwrap().decisions[0];
    expect(decision?.court).toBe("Trybunał Konstytucyjny");
    expect(decision?.decisionType).toBe("postanowienie");
  });

  test("PL Courts falls back to the dump item when a detail request times out", async () => {
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;

        if (url.includes("/api/dump/judgments")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 3,
                  courtType: "COMMON",
                  courtCases: [{ caseNumber: "III K 3/24" }],
                  judgmentType: "DECISION",
                  judgmentDate: "2024-04-03",
                  textContent:
                    "Postanowienie\n\nSygn. akt III K 3/24\n\npostanawia:\n\nutrzymać w mocy.",
                },
              ],
            }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.includes("/api/judgments/3")) {
          throw new DOMException("Timed out", "TimeoutError");
        }

        return new Response("Not found", { status: 404 });
      },
      {
        preconnect: originalFetch.preconnect.bind(originalFetch),
      },
    ) as typeof fetch;

    const result = await plCourtsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    const decision = result.unwrap().decisions[0];
    expect(decision?.caseNumber).toBe("III K 3/24");
    expect(decision?.court).toBe("Sąd powszechny");
    expect(decision?.decisionType).toBe("postanowienie");
    expect(decision?.sourceRaw).toContain('"detail":null');
  });

  test("PL Courts falls back to dump identity fields when detail is sparse", async () => {
    mockFetchWithBodies([
      {
        pattern: "/api/dump/judgments",
        body: JSON.stringify({
          items: [
            {
              id: 4,
              courtType: "COMMON",
              courtCases: [{ caseNumber: "IV Ka 4/24" }],
              judgmentType: "DECISION",
              judgmentDate: "2024-04-04",
              keywords: ["dump-keyword"],
              division: {
                id: 41,
                name: "IV Wydział Karny Odwoławczy",
                court: {
                  id: 42,
                  name: "Sąd Okręgowy w Gliwicach",
                },
              },
            },
          ],
        }),
      },
      {
        pattern: "/api/judgments/4",
        body: JSON.stringify({
          data: {
            id: 4,
            courtType: "COMMON",
            courtCases: null,
            division: null,
            judgmentType: null,
            judgmentDate: null,
            keywords: null,
            textContent:
              "Postanowienie\n\nSygn. akt IV Ka 4/24\n\npostanawia:\n\nuchylić zaskarżone postanowienie.",
          },
        }),
      },
    ]);

    const result = await plCourtsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    const decision = result.unwrap().decisions[0];
    expect(decision?.caseNumber).toBe("IV Ka 4/24");
    expect(decision?.court).toBe("Sąd Okręgowy w Gliwicach");
    expect(decision?.decisionType).toBe("postanowienie");
    expect(decision?.metadata).toMatchObject({
      courtCases: [{ caseNumber: "IV Ka 4/24" }],
      keywords: ["dump-keyword"],
    });
  });

  test("PL Courts keeps rawHash stable when detail fetch availability changes", async () => {
    let detailMode: "ok" | "timeout" = "ok";

    globalThis.fetch = Object.assign(
      async (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;

        if (url.includes("/api/dump/judgments")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 5,
                  courtType: "COMMON",
                  courtCases: [{ caseNumber: "V K 5/24" }],
                  judgmentType: "DECISION",
                  judgmentDate: "2024-05-05",
                  textContent:
                    "Postanowienie\n\nSygn. akt V K 5/24\n\npostanawia:\n\noddalić wniosek.",
                },
              ],
            }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.includes("/api/judgments/5")) {
          if (detailMode === "timeout") {
            throw new DOMException("Timed out", "TimeoutError");
          }

          return new Response(
            JSON.stringify({
              data: {
                id: 5,
                courtType: "COMMON",
                courtCases: [{ caseNumber: "V K 5/24" }],
                judgmentType: "DECISION",
                judgmentDate: "2024-05-05",
                textContent:
                  "<p>Sygn. akt V K 5/24</p><p>Postanowienie oddalające wniosek.</p>",
              },
            }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return new Response("Not found", { status: 404 });
      },
      {
        preconnect: originalFetch.preconnect.bind(originalFetch),
      },
    ) as typeof fetch;

    const first = await plCourtsAdapter.fetchPage(null, {});
    detailMode = "timeout";
    const second = await plCourtsAdapter.fetchPage(null, {});

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(first.unwrap().decisions[0]?.rawHash).toBe(
      second.unwrap().decisions[0]?.rawHash,
    );
  });

  test("PL Courts falls back to the dump item when detail JSON is malformed", async () => {
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;

        if (url.includes("/api/dump/judgments")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 6,
                  courtType: "COMMON",
                  courtCases: [{ caseNumber: "VI K 6/24" }],
                  judgmentType: "DECISION",
                  judgmentDate: "2024-06-06",
                  textContent:
                    "Postanowienie\n\nSygn. akt VI K 6/24\n\npostanawia:\n\numarzyć postępowanie.",
                },
              ],
            }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.includes("/api/judgments/6")) {
          return new Response("{broken", {
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("Not found", { status: 404 });
      },
      {
        preconnect: originalFetch.preconnect.bind(originalFetch),
      },
    ) as typeof fetch;

    const result = await plCourtsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    const decision = result.unwrap().decisions[0];
    expect(decision?.caseNumber).toBe("VI K 6/24");
    expect(decision?.sourceRaw).toContain('"detail":null');
  });

  test("PL Courts sends the shared ingestion User-Agent on detail requests", async () => {
    let detailUserAgent: string | null = null;

    globalThis.fetch = Object.assign(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;

        if (url.includes("/api/dump/judgments")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 7,
                  courtType: "COMMON",
                  courtCases: [{ caseNumber: "VII K 7/24" }],
                  judgmentType: "DECISION",
                  judgmentDate: "2024-07-07",
                  textContent: "Postanowienie\n\nSygn. akt VII K 7/24",
                },
              ],
            }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.includes("/api/judgments/7")) {
          detailUserAgent = new Headers(init?.headers).get("User-Agent");

          return new Response(
            JSON.stringify({
              data: {
                id: 7,
                courtType: "COMMON",
                courtCases: [{ caseNumber: "VII K 7/24" }],
                judgmentType: "DECISION",
                judgmentDate: "2024-07-07",
                textContent: "<p>Sygn. akt VII K 7/24</p>",
              },
            }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return new Response("Not found", { status: 404 });
      },
      {
        preconnect: originalFetch.preconnect.bind(originalFetch),
      },
    ) as typeof fetch;

    const result = await plCourtsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    expect(detailUserAgent).toBeTruthy();
  });

  test("SK Courts accepts null detail optionals without losing the decision", async () => {
    mockFetchWithBodies([
      {
        pattern: "/pilot/api/ress-isu-service/v1/rozhodnutie?",
        body: JSON.stringify({
          rozhodnutieList: [
            {
              guid: "guid-1",
              spisovaZnacka: "1Cdo/1/2024",
              sud: {
                registreGuid: "court-1",
                nazov: "Najvyssi sud SR",
              },
              datumVydania: "01.02.2024",
              formaRozhodnutia: "Rozsudok",
            },
          ],
          numFound: 1,
        }),
      },
      {
        pattern: "/pilot/api/ress-isu-service/v1/rozhodnutie/guid-1",
        body: JSON.stringify({
          guid: "guid-1",
          spisovaZnacka: "1Cdo/1/2024",
          sud: {
            registreGuid: "court-1",
            nazov: "Najvyssi sud SR",
          },
          datumVydania: "01.02.2024",
          formaRozhodnutia: "Rozsudok",
          ecli: "ECLI:SK:TEST",
          podOblast: null,
          odkazovanePredpisy: null,
          dokument: null,
          updateDate: null,
        }),
      },
    ]);

    const result = await skCourtsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    const decision = result.unwrap().decisions[0];
    expect(decision?.caseNumber).toBe("1Cdo/1/2024");
    expect(decision?.ecli).toBe("ECLI:SK:TEST");
  });

  test("PL Courts uses the extended page timeout budget for sequential detail fetches", () => {
    expect(plCourtsAdapter.pageTimeoutMs).toBe(300_000);
  });
});
