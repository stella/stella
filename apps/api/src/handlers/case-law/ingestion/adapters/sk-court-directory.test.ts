import { afterEach, describe, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  createSkCourtRegistryReader,
  isSkCourtRegistryRecord,
  skCourtDirectoryMetadata,
} from "@/api/handlers/case-law/ingestion/adapters/sk-court-directory";
import {
  assembleSkCourtsDecision,
  skCourtsAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const registry = {
  registreGuid: "sud_102",
  nazov: "Mestský súd Bratislava I",
  typSudu: "Mestský súd",
  ukonceny_string: "false",
  skratka_string: "MSBA1",
};
const item = {
  guid: "decision",
  spisovaZnacka: "7C/221/1991",
  sud: {
    registreGuid: registry.registreGuid,
    nazov: "Okresný súd Bratislava I",
  },
};

describe("court registry enrichment", () => {
  test("keeps every stated name and derives only identity-backed aliases", () => {
    for (const name of [
      item.sud.nazov,
      registry.nazov,
      "Okresný súd Bratislava I ",
    ]) {
      const result = assembleSkCourtsDecision({
        item: { ...item, sud: { ...item.sud, nazov: name } },
        detail: null,
        courtRegistry: registry,
      });
      expect(result?.court).toBe(name);
      expect(result?.metadata["courtRegistry"]).toMatchObject(registry);
      expect(result?.metadata["courtClassification"]).toEqual({
        status: "classified",
        level: "first-instance",
        jurisdiction: "general",
      });
      expect(result?.metadata["courtAlias"]).toEqual(
        name === registry.nazov
          ? undefined
          : {
              type: "same-registry-id",
              registreGuid: registry.registreGuid,
              statedName: name,
              registryName: registry.nazov,
            },
      );
    }
  });

  test("parent ids never imply succession and stated defunct values remain strings", () => {
    const record = {
      ...registry,
      registreGuid: "sud_106",
      nazov: "Okresný súd Bratislava V",
      typSudu: "Okresný súd",
      nadriadenySudId: "101",
      ukonceny_string: "true",
    };
    const metadata = skCourtDirectoryMetadata(record, record.nazov);
    expect(metadata.courtRegistry.nadriadenySudId).toBe("101");
    expect(metadata.courtRegistry.ukonceny_string).toBe("true");
    expect(metadata.courtAlias).toBeUndefined();
  });

  test("classifies administrative and special courts without guessing unknown types", () => {
    for (const [typSudu, level, jurisdiction] of [
      ["Najvyšší súd", "apex", "general"],
      ["Najvyšší správny súd", "apex", "administrative"],
      ["Ústavný súd", "apex", "constitutional"],
      ["Krajský súd", "appellate", "general"],
      ["Správny súd", "first-instance", "administrative"],
      ["Špecializovaný trestný súd", "first-instance", "special"],
      ["Špeciálny súd", "first-instance", "special"],
    ] as const) {
      expect(
        skCourtDirectoryMetadata({ ...registry, typSudu }, registry.nazov)
          .courtClassification,
      ).toEqual({ status: "classified", level, jurisdiction });
    }
    expect(
      skCourtDirectoryMetadata(
        { ...registry, typSudu: "Unrecognised" },
        registry.nazov,
      ).courtClassification,
    ).toEqual({ status: "unclassified", statedType: "Unrecognised" });
  });

  test("distinguishes NSS by registry identity when the publisher gives both apex courts the same type", () => {
    const ns = {
      ...registry,
      registreGuid: "sud_100",
      nazov: "Najvyšší súd Slovenskej republiky",
      typSudu: "Najvyšší súd SR",
    };
    const nss = {
      ...ns,
      registreGuid: "sud_175",
      nazov: "Najvyšší správny súd Slovenskej republiky",
    };
    expect(skCourtDirectoryMetadata(ns, ns.nazov).courtClassification).toEqual({
      status: "classified",
      level: "apex",
      jurisdiction: "general",
    });
    expect(
      skCourtDirectoryMetadata(nss, nss.nazov).courtClassification,
    ).toEqual({
      status: "classified",
      level: "apex",
      jurisdiction: "administrative",
    });
    expect(skCourtDirectoryMetadata(nss, nss.nazov).courtRegistry.typSudu).toBe(
      ns.typSudu,
    );
  });

  test("coalesces concurrent requests within a page and reloads on the next page", async () => {
    const requested: string[] = [];
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(JSON.stringify(registry));
    });
    const read = createSkCourtRegistryReader();
    const records = await Promise.all(
      Array.from({ length: 20 }, () => read(registry.registreGuid)),
    );
    expect(records).toEqual(Array.from({ length: 20 }, () => registry));
    expect(requested).toHaveLength(1);
    await createSkCourtRegistryReader()(registry.registreGuid);
    expect(requested).toHaveLength(2);
  });

  test("a registry failure fails the backfill page before item skips can advance it", async () => {
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.includes("/v1/sud/")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({ numFound: 1, rozhodnutieList: [item] }),
      );
    });
    const page = await skCourtsAdapter.fetchPage(null, {});
    expect(page.isErr()).toBe(true);
  });

  test("court metadata changes affect the content hash while registry presentation does not", () => {
    const build = (courtRegistry: typeof registry) =>
      assembleSkCourtsDecision({ item, detail: null, courtRegistry });
    const before = build(registry);
    const after = build({ ...registry, ukonceny_string: "true" });
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(before?.rawHash).not.toBe(after?.rawHash);
    const withPhoto = assembleSkCourtsDecision({
      item,
      detail: null,
      courtRegistry: { ...registry, foto: "changed" },
    });
    expect(withPhoto?.rawHash).toBe(before?.rawHash);
  });

  test("refuses invalid, mismatched, and unavailable registry responses", async () => {
    for (const response of [
      registry,
      { ...registry, registreGuid: "other" },
      { ...registry, typSudu: 42 },
      null,
    ]) {
      globalThis.fetch = asFetchMock(
        async () => new Response(JSON.stringify(response)),
      );
      const pending = createSkCourtRegistryReader()(registry.registreGuid);
      if (response === registry) {
        expect(await pending).toEqual(registry);
      } else {
        await expect(pending).rejects.toBeInstanceOf(AdapterFetchError);
      }
    }
    expect(isSkCourtRegistryRecord({ ...registry, nadriadenySudId: 101 })).toBe(
      false,
    );
  });

  test("replay retains registry enrichment, aliases, raw fields, and its hash", async () => {
    const record = { ...registry, publisherExtra: "kept in raw" };
    const decision = assembleSkCourtsDecision({
      item,
      detail: null,
      courtRegistry: record,
    });
    expect(decision).not.toBeNull();
    if (decision === null) {
      return;
    }
    expect(
      JSON.parse(
        decodeSourceRawEnvelope(decision.sourceRaw ?? "")?.["court-registry"] ??
          "null",
      ),
    ).toEqual(record);
    const outcome = await skCourtsAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: item.spisovaZnacka,
      sourceDocumentId: null,
      language: "sk",
      court: item.sud.nazov,
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    });
    expect(outcome?.type).toBe("parsed");
    if (outcome?.type !== "parsed") {
      return;
    }
    expect(outcome.result.metadata).toEqual(decision.metadata);
    expect(outcome.result.rawHash).toBe(decision.rawHash);
  });
});
