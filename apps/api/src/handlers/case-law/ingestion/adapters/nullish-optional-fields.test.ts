import { afterEach, describe, expect, test } from "bun:test";

import { atCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-courts";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { czRegionalAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { plCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";

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

  test("PL Courts accepts null optional objects on otherwise valid items", async () => {
    mockFetchWithBodies([
      {
        pattern: "/api/search/judgments",
        body: JSON.stringify({
          items: [
            {
              id: 1,
              courtType: "COMMON",
              courtCases: [{ caseNumber: "II AKa 10/24" }],
              judgmentType: "WYROK",
              judgmentDate: "2024-01-02",
              judges: null,
              keywords: null,
              division: null,
              source: null,
              ecli: "ECLI:PL:TEST",
            },
          ],
          info: { totalResults: 1 },
        }),
      },
    ]);

    const result = await plCourtsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);
    const decision = result.unwrap().decisions[0];
    expect(decision?.caseNumber).toBe("II AKa 10/24");
    expect(decision?.court).toBe("Common Court");
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
});
