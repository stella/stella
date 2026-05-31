import { afterEach, describe, expect, test } from "bun:test";

import { lookupByKrsNumber } from "./client.js";
import { KrsAPIError, KrsValidationError } from "./errors.js";
import type { KrsLookupResponse } from "./types.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
const readFixture = async (name: string): Promise<KrsLookupResponse> => {
  const value: unknown = await Bun.file(new URL(name, FIXTURE_DIR)).json();
  // SAFETY: fixtures are captured directly from the live KRS API
  // and committed alongside the tests; runtime validation here would
  // only catch drift between an upstream payload and the committed
  // JSON, which is precisely what the assertions below check anyway.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as KrsLookupResponse;
};

const urlString = (input: URL | Request | string): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
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

// ---------------------------------------------------------------------------
// Live tests — opt-in. Mirror the prh / brreg pattern.
//
// KRS docs cite a soft ~5 rps cap; we make at most three sequential
// calls in this block to stay well below it.
// ---------------------------------------------------------------------------
describe.skipIf(SKIP_LIVE)("lookupByKrsNumber live", () => {
  test("returns CD Projekt SA", async () => {
    const result = await lookupByKrsNumber("0000006865");
    expect(result).not.toBeNull();
    expect(result?.krsNumber).toBe("0000006865");
    expect(result?.name.toUpperCase()).toContain("CD PROJEKT");
    expect(result?.register).toBe("RejP");
  });

  test("falls back to the association register", async () => {
    const result = await lookupByKrsNumber("0000198645");
    expect(result).not.toBeNull();
    expect(result?.register).toBe("RejS");
    expect(result?.name.toUpperCase()).toContain("CARITAS");
  });

  test("returns null for a non-existent KRS number", async () => {
    const result = await lookupByKrsNumber("0000000001");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mocked fetch tests using captured upstream fixtures.
// ---------------------------------------------------------------------------
describe("lookupByKrsNumber (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("parses the live CD Projekt payload via the RejP probe", async () => {
    const body = await readFixture("lookup-cd-projekt.json");
    const seen: string[] = [];
    restore = installFetchStub(async (input) => {
      const url = urlString(input);
      seen.push(url);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const entity = await lookupByKrsNumber("0000006865");
    expect(entity).not.toBeNull();
    expect(entity?.name).toBe("CD PROJEKT SPÓŁKA AKCYJNA");
    // Pin the URL shape so a refactor cannot silently drift the
    // path or query format.
    expect(seen).toHaveLength(1);
    expect(seen.at(0)).toBe(
      "https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/0000006865?rejestr=P&format=json",
    );
  });

  test("falls back to the RejS probe on a RejP 404", async () => {
    const associationBody = await readFixture("lookup-caritas.json");
    const seen: string[] = [];
    restore = installFetchStub(async (input) => {
      const url = urlString(input);
      seen.push(url);
      if (url.includes("rejestr=P")) {
        return new Response(
          JSON.stringify({ title: "Not Found", status: 404 }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(associationBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const entity = await lookupByKrsNumber("0000198645");
    expect(entity).not.toBeNull();
    expect(entity?.register).toBe("RejS");
    expect(seen).toHaveLength(2);
    expect(seen.at(0)).toContain("rejestr=P");
    expect(seen.at(1)).toContain("rejestr=S");
  });

  test("returns null when both sub-registers 404", async () => {
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify({ title: "Not Found", status: 404 }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const entity = await lookupByKrsNumber("0000000001");
    expect(entity).toBeNull();
  });

  test("skips the fallback probe when register is pinned", async () => {
    const body = await readFixture("lookup-caritas.json");
    const seen: string[] = [];
    restore = installFetchStub(async (input) => {
      const url = urlString(input);
      seen.push(url);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await lookupByKrsNumber("0000198645", { register: "RejS" });
    expect(seen).toHaveLength(1);
    expect(seen.at(0)).toContain("rejestr=S");
  });

  test("surfaces 500 errors as KrsAPIError", async () => {
    restore = installFetchStub(
      async () =>
        new Response(
          JSON.stringify({
            type: "https://tools.ietf.org/html/rfc7231#section-6.6.1",
            title: "Internal Server Error",
            status: 500,
            detail: "Upstream timeout",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    expect(lookupByKrsNumber("0000006865")).rejects.toMatchObject({
      name: "KrsAPIError",
      httpStatus: 500,
      upstreamTitle: "Internal Server Error",
      upstreamDetail: "Upstream timeout",
    });
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe("lookupByKrsNumber validation", () => {
  test("rejects shorter inputs (no implicit padding)", () => {
    expect(lookupByKrsNumber("6865")).rejects.toBeInstanceOf(
      KrsValidationError,
    );
    expect(lookupByKrsNumber("000006865")).rejects.toBeInstanceOf(
      KrsValidationError,
    );
  });

  test("rejects non-digit inputs", () => {
    expect(lookupByKrsNumber("000000abcd")).rejects.toBeInstanceOf(
      KrsValidationError,
    );
    expect(lookupByKrsNumber("0000-006865")).rejects.toBeInstanceOf(
      KrsValidationError,
    );
  });
});

// Smoke: KrsAPIError export is reachable via barrel for consumers
// that only import from the package root.
test("exports KrsAPIError", () => {
  expect(KrsAPIError).toBeDefined();
});
