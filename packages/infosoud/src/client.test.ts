import { describe, expect, test } from "bun:test";

import { InfoSoudClient } from "./client.js";
import { InfoSoudAPIError, InfoSoudParseError } from "./errors.js";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const parseRequestBody = (
  init: RequestInit | undefined,
): Record<string, unknown> => {
  const rawBody = init?.body;
  if (typeof rawBody !== "string") {
    throw new TypeError("Expected request body to be a JSON string");
  }

  const parsedBody: unknown = JSON.parse(rawBody);
  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    Array.isArray(parsedBody)
  ) {
    throw new TypeError("Expected request body JSON to decode to an object");
  }

  return Object.fromEntries(Object.entries(parsedBody));
};

const getRequestPath = (input: URL | Request | string): string => {
  if (input instanceof URL) {
    return input.pathname;
  }

  if (typeof input === "string") {
    return new URL(input).pathname;
  }

  return new URL(input.url).pathname;
};

const createCaseSearchResponse = (overrides: Record<string, unknown> = {}) => ({
  bcVec: 64,
  cislo: 1,
  druh: "T",
  nadrizenaOrganizace: "Krajský soud Ústí nad Labem",
  napad: null,
  navazneVeci: [],
  organizace: "Okresní soud Děčín",
  platneK: null,
  rocnik: 2024,
  stav: "nevyřízená věc",
  stavDatum: "13.12.2024",
  typOrganizace: "os",
  udalosti: [],
  ...overrides,
});

describe("InfoSoudClient", () => {
  test("maps OS court codes to okresniSoud in request bodies", async () => {
    let requestBody: unknown;

    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async (_, init) => {
        requestBody = parseRequestBody(init);
        return jsonResponse(createCaseSearchResponse());
      },
    });

    await client.searchCase({ courtCode: "OSSCEDC", spisZn: "1 T 64/2024" });

    expect(requestBody).toEqual({
      bcVec: "64",
      cisloSenatu: "1",
      druhVeci: "T",
      okresniSoud: "OSSCEDC",
      rocnik: "2024",
    });
  });

  test("maps NS cases to typOrganizace without requiring an explicit court code", async () => {
    let requestBody: unknown;

    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async (_, init) => {
        requestBody = parseRequestBody(init);
        return jsonResponse(
          createCaseSearchResponse({
            bcVec: 123,
            cislo: 11,
            druh: "TDO",
            nadrizenaOrganizace: null,
            organizace: "Nejvyšší soud",
            stav: "vyřízená věc",
            stavDatum: "01.01.2025",
            typOrganizace: "ns",
          }),
        );
      },
    });

    await client.searchCase({ spisZn: "11 TDO 123/2024" });

    expect(requestBody).toEqual({
      bcVec: "123",
      cisloSenatu: "11",
      druhVeci: "TDO",
      rocnik: "2024",
      typOrganizace: "NEJVYSSI",
    });
  });

  test("rejects invalid embedded uppercase court tokens before making a request", async () => {
    let called = false;

    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async () => {
        called = true;
        return jsonResponse(createCaseSearchResponse());
      },
    });

    expect.assertions(2);

    try {
      await client.searchCase({ spisZn: "4 T 21/2025 MELNIK" });
    } catch (error) {
      expect(error).toBeInstanceOf(InfoSoudParseError);
      expect(called).toBe(false);
    }
  });

  test("tries Prague districts until one request succeeds", async () => {
    const seenBodies: unknown[] = [];

    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async (_, init) => {
        const body = parseRequestBody(init);
        seenBodies.push(body);

        if (body["okresniSoud"] === "OSPHA01") {
          return jsonResponse(
            {
              error: "Bad Request",
              message: "not found",
              path: "/infosoud/api/v1/jednani/vyhledej",
              status: 400,
              timestamp: "2026-04-05T00:00:00.000+00:00",
            },
            400,
          );
        }

        return jsonResponse({
          bcVec: 21,
          cislo: 4,
          datum: null,
          druh: "T",
          jednaciSin: null,
          nadrizenaOrganizace: "Krajský soud Praha",
          organizace: "Obvodní soud Praha 9",
          platneK: null,
          rocnik: 2025,
          typ: "SPZN",
          udalosti: [],
        });
      },
    });

    const result = await client.searchHearings({
      courtCode: "OSPHA",
      spisZn: "4 T 21/2025",
    });

    expect(result.organizace).toBe("Obvodní soud Praha 9");
    expect(seenBodies).toEqual([
      {
        bcVec: "21",
        cisloSenatu: "4",
        druhVeci: "T",
        okresniSoud: "OSPHA01",
        rocnik: "2025",
        typHledani: "SPZN",
      },
      {
        bcVec: "21",
        cisloSenatu: "4",
        druhVeci: "T",
        okresniSoud: "OSPHA02",
        rocnik: "2025",
        typHledani: "SPZN",
      },
    ]);
  });

  test("returns case data with empty hearings when the hearings endpoint has no rows", async () => {
    const seenBodies: Record<string, unknown>[] = [];

    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async (input, init) => {
        const path = getRequestPath(input);
        const body = init ? parseRequestBody(init) : {};
        seenBodies.push(body);

        if (path === "/api/v1/rizeni/vyhledej") {
          return jsonResponse(
            createCaseSearchResponse({
              organizace: "Obvodní soud Praha 2",
              udalosti: [
                {
                  datum: "10.04.2025",
                  jednani: [],
                  poradi: 1,
                  udalost: "ZAHAJ_RIZ",
                  udalostId: null,
                  znackaId: {
                    bcVec: 64,
                    cisloSenatu: 1,
                    druhVeci: "T",
                    organizace: "OSPHA02",
                    rocnik: 2024,
                  },
                  zruseno: false,
                },
              ],
            }),
          );
        }

        if (path === "/api/v1/jednani/vyhledej") {
          return jsonResponse(
            {
              error: "Bad Request",
              message: "JEDNANI_0000#1 T 64 / 2024#Obvodní soud Praha 2",
              path,
              status: 400,
              timestamp: "2026-04-05T00:00:00.000+00:00",
            },
            400,
          );
        }

        throw new Error(`Unexpected request path: ${path}`);
      },
    });

    const result = await client.searchCaseWithHearings({
      courtCode: "OSPHA",
      spisZn: "1 T 64/2024",
    });

    expect(result.case.organizace).toBe("Obvodní soud Praha 2");
    expect(result.hearings).toEqual({
      bcVec: 64,
      cislo: 1,
      datum: null,
      druh: "T",
      jednaciSin: null,
      nadrizenaOrganizace: "Krajský soud Ústí nad Labem",
      organizace: "Obvodní soud Praha 2",
      platneK: null,
      rocnik: 2024,
      typ: "SPZN",
      udalosti: [],
    });
    expect(seenBodies).toEqual([
      {
        bcVec: "64",
        cisloSenatu: "1",
        druhVeci: "T",
        okresniSoud: "OSPHA01",
        rocnik: "2024",
      },
      {
        bcVec: "64",
        cisloSenatu: "1",
        druhVeci: "T",
        okresniSoud: "OSPHA02",
        rocnik: "2024",
        typHledani: "SPZN",
      },
    ]);
  });

  test("uses the resolved Prague district code when hydrating event details", async () => {
    const seenBodies: Record<string, unknown>[] = [];

    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async (input, init) => {
        const path = getRequestPath(input);
        const body = init ? parseRequestBody(init) : {};

        if (path === "/api/v1/rizeni/vyhledej") {
          seenBodies.push(body);

          if (body["okresniSoud"] === "OSPHA01") {
            return jsonResponse(
              {
                error: "Bad Request",
                message: "not found",
                path,
                status: 400,
                timestamp: "2026-04-06T00:00:00.000+00:00",
              },
              400,
            );
          }

          return jsonResponse(
            createCaseSearchResponse({
              organizace: "Obvodní soud Praha 2",
              udalosti: [
                {
                  datum: "10.04.2025",
                  jednani: [],
                  poradi: 1,
                  udalost: "NAR_JED",
                  udalostId: 1001,
                  znackaId: {
                    bcVec: 64,
                    cisloSenatu: 1,
                    druhVeci: "T",
                    organizace: "OSPHA02",
                    rocnik: 2024,
                  },
                  zruseno: false,
                },
              ],
            }),
          );
        }

        if (path === "/api/v1/udalost/vyhledej") {
          seenBodies.push(body);
          return jsonResponse({
            atributy: [{ hodnota: "101", typ: "JED_SIN" }],
            bcVec: 64,
            cislo: 1,
            datumUdalost: "10.04.2025",
            druh: "T",
            nadrizenaOrganizace: "Městský soud v Praze",
            napad: null,
            navazneVeci: [],
            organizace: "Obvodní soud Praha 2",
            platneK: null,
            rocnik: 2024,
            stav: "nevyřízená věc",
            stavDatum: "13.12.2024",
            typOrganizace: "os",
            typUdalosti: "NAR_JED",
          });
        }

        throw new Error(`Unexpected request path: ${path}`);
      },
    });

    const result = await client.searchCaseWithDetails({
      courtCode: "OSPHA",
      spisZn: "1 T 64/2024",
    });

    expect(result.udalosti.at(0)?.detailAttributes["JED_SIN"]).toBe("101");
    expect(seenBodies).toEqual([
      {
        bcVec: "64",
        cisloSenatu: "1",
        druhVeci: "T",
        okresniSoud: "OSPHA01",
        rocnik: "2024",
      },
      {
        bcVec: "64",
        cisloSenatu: "1",
        druhVeci: "T",
        okresniSoud: "OSPHA02",
        rocnik: "2024",
      },
      {
        bcVec: "64",
        cisloSenatu: "1",
        druhUdalosti: "NAR_JED",
        druhVeci: "T",
        okresniSoud: "OSPHA02",
        poradiUdalosti: "1",
        rocnik: "2024",
      },
    ]);
  });

  test("uses the event case mark when hydrating related-case event details", async () => {
    const seenBodies: Record<string, unknown>[] = [];

    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async (input, init) => {
        const path = getRequestPath(input);
        const body = init ? parseRequestBody(init) : {};

        if (path === "/api/v1/rizeni/vyhledej") {
          return jsonResponse(
            createCaseSearchResponse({
              udalosti: [
                {
                  datum: "10.04.2025",
                  jednani: [],
                  poradi: 2,
                  udalost: "NAR_JED",
                  udalostId: 1002,
                  znackaId: {
                    bcVec: 436,
                    cisloSenatu: 6,
                    druhVeci: "TO",
                    organizace: "KSSCEUL",
                    rocnik: 2025,
                  },
                  zruseno: false,
                },
              ],
            }),
          );
        }

        if (path === "/api/v1/udalost/vyhledej") {
          seenBodies.push(body);
          return jsonResponse({
            atributy: [{ hodnota: "101", typ: "JED_SIN" }],
            bcVec: 436,
            cislo: 6,
            datumUdalost: "10.04.2025",
            druh: "TO",
            nadrizenaOrganizace: "Vrchní soud v Praze",
            napad: null,
            navazneVeci: [],
            organizace: "Krajský soud Ústí nad Labem",
            platneK: null,
            rocnik: 2025,
            stav: "nevyřízená věc",
            stavDatum: "13.12.2024",
            typOrganizace: "ks",
            typUdalosti: "NAR_JED",
          });
        }

        throw new Error(`Unexpected request path: ${path}`);
      },
    });

    const result = await client.searchCaseWithDetails({
      courtCode: "OSSCEDC",
      spisZn: "1 T 64/2024",
    });

    expect(result.udalosti.at(0)?.detailAttributes["JED_SIN"]).toBe("101");
    expect(seenBodies).toEqual([
      {
        bcVec: "436",
        cisloSenatu: "6",
        druhOrganizace: "KSSCEUL",
        druhUdalosti: "NAR_JED",
        druhVeci: "TO",
        poradiUdalosti: "2",
        rocnik: "2025",
      },
    ]);
  });

  test("throws typed upstream errors on non-2xx responses", async () => {
    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async () =>
        jsonResponse(
          {
            error: "Bad Request",
            message: "RIZENI_0000#999 T 64 / 2024#Okresní soud Děčín",
            path: "/infosoud/api/v1/rizeni/vyhledej",
            status: 400,
            timestamp: "2026-04-05T00:00:00.000+00:00",
          },
          400,
        ),
    });

    expect.assertions(1);

    try {
      await client.searchCase({
        courtCode: "OSSCEDC",
        spisZn: "999 T 64/2024",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(InfoSoudAPIError);
    }
  });

  test("reuses cached case lookups by default", async () => {
    let requestCount = 0;

    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async () => {
        requestCount += 1;
        return jsonResponse(createCaseSearchResponse());
      },
    });

    await client.searchCase({ courtCode: "OSSCEDC", spisZn: "1 T 64/2024" });
    await client.searchCase({ courtCode: "OSSCEDC", spisZn: "1 T 64/2024" });

    expect(requestCount).toBe(1);
  });

  test("clearCache forces the next identical lookup to refetch", async () => {
    let requestCount = 0;

    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async () => {
        requestCount += 1;
        return jsonResponse(createCaseSearchResponse());
      },
    });

    await client.searchCase({ courtCode: "OSSCEDC", spisZn: "1 T 64/2024" });
    client.clearCache();
    await client.searchCase({ courtCode: "OSSCEDC", spisZn: "1 T 64/2024" });

    expect(requestCount).toBe(2);
  });

  test("hydrates matching case events with parsed event detail helpers", async () => {
    const seenPaths: string[] = [];

    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async (input, init) => {
        const path = getRequestPath(input);
        seenPaths.push(path);

        if (path === "/api/v1/rizeni/vyhledej") {
          return jsonResponse(
            createCaseSearchResponse({
              udalosti: [
                {
                  datum: "10.04.2025",
                  jednani: [],
                  poradi: 1,
                  udalost: "NAR_JED",
                  udalostId: 1001,
                  znackaId: {
                    bcVec: 64,
                    cisloSenatu: 1,
                    druhVeci: "T",
                    organizace: "OSSCEDC",
                    rocnik: 2024,
                  },
                  zruseno: false,
                },
                {
                  datum: "11.04.2025",
                  jednani: [],
                  poradi: 2,
                  udalost: "VYD_ROZH",
                  udalostId: 1002,
                  znackaId: {
                    bcVec: 64,
                    cisloSenatu: 1,
                    druhVeci: "T",
                    organizace: "OSSCEDC",
                    rocnik: 2024,
                  },
                  zruseno: false,
                },
              ],
            }),
          );
        }

        if (path === "/api/v1/udalost/vyhledej") {
          expect(parseRequestBody(init)).toEqual({
            bcVec: "64",
            cisloSenatu: "1",
            druhUdalosti: "NAR_JED",
            druhVeci: "T",
            okresniSoud: "OSSCEDC",
            poradiUdalosti: "1",
            rocnik: "2024",
          });

          return jsonResponse({
            atributy: [
              { hodnota: "Ano", typ: "JED_ZRUS" },
              { hodnota: "101", typ: "JED_SIN" },
              { hodnota: "2025-04-15T08:30:00", typ: "JED_D_ZAC" },
            ],
            bcVec: 64,
            cislo: 1,
            datumUdalost: "15.04.2025",
            druh: "T",
            nadrizenaOrganizace: "Krajský soud Ústí nad Labem",
            napad: null,
            navazneVeci: [],
            organizace: "Okresní soud Děčín",
            platneK: null,
            rocnik: 2024,
            stav: "nevyřízená věc",
            stavDatum: "13.12.2024",
            typOrganizace: "os",
            typUdalosti: "NAR_JED",
          });
        }

        throw new Error(`Unexpected request path: ${path}`);
      },
    });

    const result = await client.searchCaseWithDetails({
      courtCode: "OSSCEDC",
      spisZn: "1 T 64/2024",
    });
    const firstEvent = result.udalosti.at(0);
    const secondEvent = result.udalosti.at(1);

    expect(seenPaths).toEqual([
      "/api/v1/rizeni/vyhledej",
      "/api/v1/udalost/vyhledej",
    ]);
    expect(firstEvent?.detail?.typUdalosti).toBe("NAR_JED");
    expect(firstEvent?.decodedDetail?.kind).toBe("hearing");
    expect(firstEvent?.detailAttributes["JED_SIN"]).toBe("101");
    expect(firstEvent?.hearingDetail).toEqual({
      cancelled: true,
      hearingType: null,
      result: null,
      resultRecordedOn: null,
      resultRecordedOnDate: {
        isoDate: null,
        raw: null,
        unixMs: null,
      },
      room: "101",
      startsAt: "2025-04-15T08:30:00",
      startsAtDateTime: {
        isoDateTime: "2025-04-15T08:30:00",
        raw: "2025-04-15T08:30:00",
        unixMs: Date.UTC(2025, 3, 15, 6, 30, 0),
      },
    });
    expect(secondEvent?.detail).toBeNull();
    expect(secondEvent?.decodedDetail).toBeNull();
    expect(secondEvent?.hearingDetail).toBeNull();
  });

  test("treats missing event detail payloads as null detail entries", async () => {
    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async (input) => {
        const path = getRequestPath(input);

        if (path === "/api/v1/rizeni/vyhledej") {
          return jsonResponse(
            createCaseSearchResponse({
              udalosti: [
                {
                  datum: "10.04.2025",
                  jednani: [],
                  poradi: 1,
                  udalost: "NAR_JED",
                  udalostId: 1001,
                  znackaId: {
                    bcVec: 64,
                    cisloSenatu: 1,
                    druhVeci: "T",
                    organizace: "OSSCEDC",
                    rocnik: 2024,
                  },
                  zruseno: false,
                },
              ],
            }),
          );
        }

        if (path === "/api/v1/udalost/vyhledej") {
          return jsonResponse(
            {
              error: "Bad Request",
              message: "detail missing",
              path,
              status: 400,
              timestamp: "2026-04-05T00:00:00.000+00:00",
            },
            400,
          );
        }

        throw new Error(`Unexpected request path: ${path}`);
      },
    });

    const result = await client.searchCaseWithDetails({
      courtCode: "OSSCEDC",
      spisZn: "1 T 64/2024",
    });
    const firstEvent = result.udalosti.at(0);

    expect(firstEvent?.detail).toBeNull();
    expect(firstEvent?.decodedDetail).toBeNull();
    expect(firstEvent?.detailAttributes).toEqual({});
    expect(firstEvent?.hearingDetail).toBeNull();
  });

  test("treats omitted nullable boolean and number fields as null", async () => {
    const client = new InfoSoudClient({
      delayMs: 0,
      fetch: async (input) => {
        const path = getRequestPath(input);

        if (path === "/api/v1/rizeni/vyhledej") {
          return jsonResponse(
            createCaseSearchResponse({
              udalosti: [
                {
                  datum: "10.04.2025",
                  jednani: [],
                  poradi: 1,
                  udalost: "ZAHAJ_RIZ",
                  znackaId: {
                    bcVec: 64,
                    cisloSenatu: 1,
                    druhVeci: "T",
                    organizace: "OSSCEDC",
                    rocnik: 2024,
                  },
                  zruseno: false,
                },
              ],
            }),
          );
        }

        if (path === "/api/v1/jednani/vyhledej") {
          return jsonResponse({
            bcVec: 21,
            cislo: 4,
            datum: null,
            druh: "T",
            jednaciSin: null,
            nadrizenaOrganizace: "Krajský soud Praha",
            organizace: "Obvodní soud Praha 9",
            platneK: null,
            rocnik: 2025,
            typ: "SPZN",
            udalosti: [
              {
                cas: "08:30",
                datum: "10.04.2026",
                druhJednani: null,
                jednaciSin: null,
                predmetJednani: null,
                resitel: null,
                vysledek: null,
              },
            ],
          });
        }

        throw new Error(`Unexpected request path: ${path}`);
      },
    });

    const caseResult = await client.searchCase({
      courtCode: "OSSCEDC",
      spisZn: "1 T 64/2024",
    });
    const hearingsResult = await client.searchHearings({
      courtCode: "OSPHA09",
      spisZn: "4 T 21/2025",
    });

    expect(caseResult.udalosti.at(0)?.udalostId).toBeNull();
    expect(hearingsResult.udalosti.at(0)).toEqual({
      bcVec: null,
      cas: "08:30",
      cislo: null,
      datum: "10.04.2026",
      datumZapisuVysledku: null,
      druh: null,
      druhJednani: null,
      jednaciSin: null,
      jednaniZruseno: null,
      neverejneJednani: null,
      predmetJednani: null,
      resitel: null,
      rocnik: null,
      vysledek: null,
    });
  });
});
