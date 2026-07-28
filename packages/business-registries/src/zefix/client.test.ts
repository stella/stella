import { afterEach, describe, expect, test } from "bun:test";

import { lookupByUid, searchByName } from "./client.js";
import { ZefixAPIError, ZefixValidationError } from "./errors.js";
import type { ZefixRawFirm, ZefixSearchResponse } from "./types.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";
const FIXTURE = new URL("__fixtures__/search-swiss-re.json", import.meta.url);

const readFixture = async (): Promise<ZefixSearchResponse> => {
  const value: unknown = await Bun.file(FIXTURE).json();
  // SAFETY: the captured response is checked by the client shape guard.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as ZefixSearchResponse;
};

const installFetchStub = (
  handler: (
    input: URL | Request | string,
    init?: RequestInit,
  ) => Promise<Response>,
) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string, init?: RequestInit) =>
      handler(input, init),
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
  };
};

describe.skipIf(SKIP_LIVE)("Zefix live", () => {
  test("looks up Swiss Re by UID", async () => {
    const company = await lookupByUid("CHE-191.546.434");
    expect(company?.name).toBe("Swiss Re AG");
    expect(company?.status).toEqual({ type: "active" });
  });
});

describe("Zefix client", () => {
  let restore = () => {};
  afterEach(() => {
    restore();
    restore = () => {};
  });

  test("looks up and normalizes a formatted UID", async () => {
    const fixture = await readFixture();
    let body = "";
    restore = installFetchStub(async (_input, init) => {
      body = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const company = await lookupByUid("CHE-191.546.434");
    expect(company).not.toBeNull();
    if (!company) {
      return;
    }
    expect(String(company.uid)).toBe("191546434");
    expect(company).toMatchObject({
      uidFormatted: "CHE-191.546.434",
      name: "Swiss Re AG",
      legalSeat: "Zürich",
      legalFormId: 3,
      status: { type: "active" },
      registryUrl:
        "https://zh.chregister.ch/cr-portal/auszug/auszug.xhtml?uid=CHE-191.546.434",
    });
    expect(JSON.parse(body)).toMatchObject({
      name: "191546434",
      maxEntries: 2,
    });
  });

  test("returns null for the registry no-result envelope", async () => {
    restore = installFetchStub(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "API.ZFR.SEARCH.NORESULT" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
    );
    expect(lookupByUid("191546434")).resolves.toBeNull();
  });

  test("does not accept a fuzzy nonmatching hit for ID lookup", async () => {
    const fixture = await readFixture();
    const list: ZefixRawFirm[] = [];
    for (const entry of fixture.list ?? []) {
      list.push({
        ...entry,
        uid: "CHE116281710",
        uidFormatted: "CHE-116.281.710",
      });
    }
    restore = installFetchStub(
      async () =>
        new Response(
          JSON.stringify({
            ...fixture,
            list,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    expect(lookupByUid("191546434")).resolves.toBeNull();
  });

  test("searches by name and forwards a bounded result count", async () => {
    const fixture = await readFixture();
    let body = "";
    restore = installFetchStub(async (_input, init) => {
      body = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const companies = await searchByName("Swiss Re", { limit: 500 });
    expect(companies).toHaveLength(1);
    expect(String(companies.at(0)?.uid)).toBe("191546434");
    expect(JSON.parse(body)).toMatchObject({
      name: "Swiss Re",
      maxEntries: 50,
    });
  });

  test("rejects invalid UIDs and empty names before fetch", () => {
    expect(lookupByUid("CHE-191.546.435")).rejects.toBeInstanceOf(
      ZefixValidationError,
    );
    expect(searchByName("  ")).rejects.toBeInstanceOf(ZefixValidationError);
  });

  test("wraps malformed successful payloads", async () => {
    restore = installFetchStub(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    expect(lookupByUid("191546434")).rejects.toBeInstanceOf(ZefixAPIError);
  });

  test("rejects a successful response without a result list", async () => {
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    expect(lookupByUid("191546434")).rejects.toBeInstanceOf(ZefixAPIError);
  });
});
