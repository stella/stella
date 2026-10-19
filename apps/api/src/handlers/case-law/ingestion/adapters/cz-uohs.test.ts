import { afterEach, describe, expect, test } from "bun:test";

import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildCzUohsDecision,
  czUohsCollectionOf,
  czUohsDecisionIdentifiers,
  parseCzUohsListing,
} from "@/api/handlers/case-law/ingestion/adapters/cz-uohs";
import { publishedCaseLawDecisionIndexPredicateSql } from "@/api/lib/case-law/published-decisions-sql";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const FIXTURES = new URL("__fixtures__/", import.meta.url);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const records = async () =>
  parseCzUohsListing(
    await Bun.file(new URL("cz-uohs-decisions.jsonld", FIXTURES)).json(),
  );

describe("ÚOHS JSON-LD", () => {
  test("maps every stated field and discriminates collections without a default", async () => {
    const listed = await records();
    const first = listed[0]!;
    expect(czUohsCollectionOf(first)).toBe("verejne-zakazky");
    expect(czUohsCollectionOf(listed[1]!)).toBe("hospodarska-soutez");
    expect(czUohsCollectionOf(listed[2]!)).toBe("verejna-podpora");
    expect(first).toEqual(
      expect.objectContaining({
        číslo_jednací: "90001/2026/163",
        spisová_značka: "R0901/2026/VZ",
        věc: { cs: "Fiktivní veřejná zakázka na dodávku techniky" },
        instance: ["https://uohs.gov.cz/cs/ciselniky/instance/2.html"],
      }),
    );
    expect(listed[1]!.datum_právní_moci).toBeUndefined();
    expect(() => czUohsCollectionOf(listed[3]!)).toThrow(
      "CzUohsUnknownCollectionError",
    );
  });

  test("emits citation-shaped authority identifiers", async () => {
    expect(czUohsDecisionIdentifiers((await records())[0]!)).toEqual([
      { type: "authority-decision-number", value: "úohs-r0901/2026/vz" },
      { type: "authority-decision-number", value: "úohs-90001/2026/163" },
    ]);
  });

  test("fetches the PDF and retains both raw responses with provenance", async () => {
    const bytes = new Uint8Array(
      await Bun.file(new URL("cz-uohs-decision.pdf", FIXTURES)).arrayBuffer(),
    );
    globalThis.fetch = asFetchMock(
      async () =>
        new Response(bytes, { headers: { "Content-Type": "application/pdf" } }),
    );
    const decision = await buildCzUohsDecision(
      (await records())[0]!,
      "2026-10-19T00:00:00.000Z",
    );
    expect(decision.fulltext).toContain("Fiktivni rozhodnuti");
    expect(decision.sourceRawObjects?.["document"]?.bytes).toEqual(bytes);
    const raw = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(JSON.parse(raw?.["listing"] ?? "null")).toEqual(
      (await records())[0],
    );
    expect(JSON.parse(raw?.["provenance"] ?? "null")).toEqual(
      expect.objectContaining({
        listing: expect.objectContaining({
          url: "https://uohs.gov.cz/opendata/rozhodnuti.jsonld",
          sha256: expect.any(String),
        }),
        document: expect.objectContaining({ sha256: expect.any(String) }),
      }),
    );
    expect(JSON.stringify(decision.metadata["participants"])).toBe(
      JSON.stringify([{ typ: "Osoba", jméno: { cs: "obec Fiktivní Lhota" } }]),
    );
  });

  test("keeps PDF bytes when text extraction fails", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    globalThis.fetch = asFetchMock(async () => new Response(bytes));
    const decision = await buildCzUohsDecision(
      (await records())[0]!,
      "2026-10-19T00:00:00.000Z",
    );
    expect(decision.sourceRawObjects?.["document"]?.bytes).toEqual(bytes);
    expect(decision.metadata["documentExtraction"]).toEqual(
      expect.objectContaining({ type: "failed" }),
    );
  });

  test("keeps a redacted ÚOHS decision outside the published view", () => {
    expect(publishedCaseLawDecisionIndexPredicateSql()).toContain(
      "redacted_at IS NULL",
    );
  });
});
