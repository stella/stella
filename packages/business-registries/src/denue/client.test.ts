import { afterEach, describe, expect, test } from "bun:test";

import { lookupByEstablishmentId, searchByName } from "./client.js";
import {
  DenueAPIError,
  DenueAuthError,
  DenueRequestError,
  DenueValidationError,
} from "./errors.js";
import type { DenueResponse } from "./types.js";

const SKIP_LIVE =
  process.env["SMOKE_TEST"] !== "1" || !process.env["INEGI_DENUE_API_TOKEN"];

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
const readFixture = async (name: string): Promise<DenueResponse> => {
  const value: unknown = await Bun.file(new URL(name, FIXTURE_DIR)).json();
  // SAFETY: fixtures are committed JSON payloads shaped like DENUE
  // responses; parser tests below assert the important fields.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as DenueResponse;
};

const installFetchStub = (
  handler: (input: URL | Request | string) => Promise<Response>,
) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string) => handler(input),
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
  };
};

const getFetchInputUrl = (input: URL | Request | string): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

describe.skipIf(SKIP_LIVE)("lookupByEstablishmentId live", () => {
  test("returns the DENUE sample establishment", async () => {
    const company = await lookupByEstablishmentId("6281106", {
      token: process.env["INEGI_DENUE_API_TOKEN"] ?? "",
    });
    expect(company).not.toBeNull();
    expect(company?.id).toBe("6281106");
  });
});

describe("lookupByEstablishmentId (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("parses a DENUE ficha payload", async () => {
    const body = await readFixture("lookup-hotel.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const company = await lookupByEstablishmentId("6281106", {
      token: "test-token",
    });
    expect(company).not.toBeNull();
    expect(company?.id).toBe("6281106");
    expect(company?.name).toBe("HOTEL MARRIOTT REFORMA");
    expect(company?.legalName).toBe("HOTELERA REFORMA SA DE CV");
    expect(company?.activityClass).toBe(
      "Hoteles con otros servicios integrados",
    );
    expect(company?.address?.line1).toBe("AVENIDA PASEO DE LA REFORMA 276");
    expect(company?.address?.municipality).toBe("CUAUHTEMOC");
    expect(company?.address?.state).toBe("CIUDAD DE MEXICO");
    expect(company?.coordinates).toEqual({
      latitude: 19.428_611,
      longitude: -99.162_222,
    });
    expect(company?.registryUrl).toBe(
      "https://www.inegi.org.mx/app/mapa/denue/default.aspx?idee=6281106",
    );
  });

  test("returns null when DENUE reports no results", async () => {
    const body = await readFixture("lookup-not-found.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const company = await lookupByEstablishmentId("999999999", {
      token: "test-token",
    });
    expect(company).toBeNull();
  });

  test("does not leak the token on request failures", async () => {
    restore = installFetchStub(async () => {
      throw new Error("network down");
    });

    try {
      await lookupByEstablishmentId("6281106", { token: "secret token" });
      throw new Error("expected request failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DenueRequestError);
      if (error instanceof DenueRequestError) {
        expect(error.url).toContain("[redacted]");
        expect(error.url).not.toContain("secret");
      }
    }
  });

  test("maps 403 responses to DenueAuthError", () => {
    restore = installFetchStub(
      async () =>
        new Response("Forbidden", {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        }),
    );

    expect(
      lookupByEstablishmentId("6281106", { token: "bad-token" }),
    ).rejects.toBeInstanceOf(DenueAuthError);
  });

  test("wraps malformed successful JSON as DenueAPIError", () => {
    restore = installFetchStub(
      async () =>
        new Response("{not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    expect(
      lookupByEstablishmentId("6281106", { token: "test-token" }),
    ).rejects.toBeInstanceOf(DenueAPIError);
  });
});

describe("searchByName (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("uses the Nombre endpoint and parses search hits", async () => {
    const body = await readFixture("search-marriott.json");
    const requestedUrls: string[] = [];
    restore = installFetchStub(async (input) => {
      requestedUrls.push(getFetchInputUrl(input));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const results = await searchByName(
      "Marriott",
      { token: "test-token" },
      { limit: 1 },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("6281106");
    expect(results[0]?.legalName).toBe("HOTELERA REFORMA SA DE CV");
    expect(results[0]?.address).toContain("PASEO DE LA REFORMA");
    expect(requestedUrls[0]).toContain("/Nombre/Marriott/00/1/1/test-token");
  });

  test("passes a state code when provided", async () => {
    const body = await readFixture("search-marriott.json");
    const requestedUrls: string[] = [];
    restore = installFetchStub(async (input) => {
      requestedUrls.push(getFetchInputUrl(input));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await searchByName("Marriott", { token: "test-token" }, { stateCode: "9" });
    expect(requestedUrls[0]).toContain("/Nombre/Marriott/09/");
  });

  test("surfaces DENUE error-string responses", () => {
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(["Error en parametros"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    expect(
      searchByName("Marriott", { token: "test-token" }),
    ).rejects.toBeInstanceOf(DenueAPIError);
  });
});

describe("DENUE client validation", () => {
  test("rejects invalid establishment ids", () => {
    expect(
      lookupByEstablishmentId("ABC123", { token: "test-token" }),
    ).rejects.toBeInstanceOf(DenueValidationError);
  });

  test("rejects empty tokens", () => {
    expect(
      lookupByEstablishmentId("6281106", { token: " " }),
    ).rejects.toBeInstanceOf(DenueAuthError);
  });

  test("rejects empty search names and invalid state codes", () => {
    expect(searchByName("", { token: "test-token" })).rejects.toBeInstanceOf(
      DenueValidationError,
    );
    expect(
      searchByName("Marriott", { token: "test-token" }, { stateCode: "99" }),
    ).rejects.toBeInstanceOf(DenueValidationError);
  });
});
