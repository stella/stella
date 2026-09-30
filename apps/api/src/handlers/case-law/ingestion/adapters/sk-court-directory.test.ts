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
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
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
        courtRegistry: { status: "available", record: registry },
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
      const classification = skCourtDirectoryMetadata(
        { ...registry, typSudu },
        registry.nazov,
      ).courtClassification;
      expect(classification.status).toBe("classified");
      if (classification.status !== "classified") {
        continue;
      }
      expect(classification.level).toBe(level);
      expect(classification.jurisdiction).toBe(jurisdiction);
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
      requested.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify(registry));
    });
    const read = createSkCourtRegistryReader();
    const records = await Promise.all(
      Array.from({ length: 20 }, async () => await read(registry.registreGuid)),
    );
    expect(records.map((record) => record.unwrap())).toEqual(
      Array.from({ length: 20 }, () => ({
        status: "available",
        record: registry,
      })),
    );
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
      assembleSkCourtsDecision({
        item,
        detail: null,
        courtRegistry: { status: "available", record: courtRegistry },
      });
    const before = build(registry);
    const after = build({ ...registry, ukonceny_string: "true" });
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(before?.rawHash).not.toBe(after?.rawHash);
    const withPhoto = assembleSkCourtsDecision({
      item,
      detail: null,
      courtRegistry: {
        status: "available",
        record: { ...registry, foto: "changed" },
      },
    });
    expect(withPhoto?.rawHash).toBe(before?.rawHash);
  });

  test("classifies permanent refusals and malformed JSON separately from transient failures", async () => {
    for (const [body, status, reason] of [
      ["not found", 404, "http-refusal"],
      ["gone", 410, "http-refusal"],
      ["<html>not JSON</html>", 200, "invalid-json"],
      [
        JSON.stringify({ ...registry, registreGuid: "other" }),
        200,
        "invalid-shape",
      ],
      [JSON.stringify({ ...registry, typSudu: 42 }), 200, "invalid-shape"],
      ["x".repeat(1024 * 1024 + 1), 200, "response-too-large"],
    ] as const) {
      globalThis.fetch = asFetchMock(
        async () => new Response(body, { status }),
      );
      const result = await createSkCourtRegistryReader()(registry.registreGuid);
      expect(result.unwrap()).toEqual({
        status: "unavailable",
        httpStatus: status,
        reason,
      });
    }
    for (const status of [408, 425, 429, 503]) {
      globalThis.fetch = asFetchMock(
        async () => new Response("retry", { status }),
      );
      const result = await createSkCourtRegistryReader()(registry.registreGuid);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(AdapterFetchError);
      }
    }
    expect(isSkCourtRegistryRecord({ ...registry, nadriadenySudId: 101 })).toBe(
      false,
    );
  });

  test("permanent registry refusals keep the decision and advance the page", async () => {
    for (const [body, status, reason] of [
      ["not found", 404, "http-refusal"],
      ["<html>not JSON</html>", 200, "invalid-json"],
      [JSON.stringify({ typSudu: 42 }), 200, "invalid-shape"],
      ["x".repeat(1024 * 1024 + 1), 200, "response-too-large"],
    ] as const) {
      globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.includes("/v1/sud/")) {
          return new Response(body, { status });
        }
        if (url.searchParams.has("page")) {
          return new Response(
            JSON.stringify({ numFound: 1, rozhodnutieList: [item] }),
          );
        }
        return new Response(JSON.stringify(item));
      });
      const page = await skCourtsAdapter.fetchPage(null, {});
      expect(page.isOk()).toBe(true);
      if (page.isErr()) {
        continue;
      }
      const decision = page.value.decisions.at(0);
      expect(decision?.caseNumber).toBe(item.spisovaZnacka);
      expect(decision?.court).toBe(item.sud.nazov);
      expect(decision?.metadata["courtRegistry"]).toEqual({
        status: "unavailable",
        httpStatus: status,
        reason,
      });
      expect(page.value.nextCursor).not.toBeNull();
    }
  });

  test("a transient failure is not cached into later reconciliation attempts", async () => {
    let calls = 0;
    globalThis.fetch = asFetchMock(async () => {
      calls += 1;
      return calls === 1
        ? new Response("retry", { status: 503 })
        : new Response(JSON.stringify(registry));
    });
    const read = createSkCourtRegistryReader();
    expect((await read(registry.registreGuid)).isErr()).toBe(true);
    expect((await read(registry.registreGuid)).unwrap()).toEqual({
      status: "available",
      record: registry,
    });
    expect(calls).toBe(2);
  });

  test("defunct classification preserves the stated flag", () => {
    for (const [ukonceny_string, defunct] of [
      ["true", true],
      ["false", false],
      [null, "not_stated"],
    ] as const) {
      const metadata = skCourtDirectoryMetadata(
        { ...registry, ukonceny_string },
        registry.nazov,
      );
      expect(metadata.courtRegistry.ukonceny_string).toBe(ukonceny_string);
      expect(metadata.courtRegistry.defunct).toBe(defunct);
    }
    const unstated = skCourtDirectoryMetadata(
      { registreGuid: registry.registreGuid, nazov: registry.nazov },
      registry.nazov,
    );
    expect(unstated.courtRegistry.defunct).toBe("not_stated");
  });

  test("a reconciliation slice shares its registry reader and the next slice refreshes it", async () => {
    let registryCalls = 0;
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.includes("/v1/sud/")) {
        registryCalls += 1;
        return new Response(JSON.stringify(registry));
      }
      return new Response(JSON.stringify(item));
    });
    const reconciliation = requireReconciliation(skCourtsAdapter);
    const createBuild = reconciliation.createSliceBuildDecision;
    expect(createBuild).toBeDefined();
    if (createBuild === undefined) {
      return;
    }
    const build = createBuild();
    expect((await build(item)).type).toBe("built");
    expect(
      (await build({ ...item, guid: "another", spisovaZnacka: "7C/222/1991" }))
        .type,
    ).toBe("built");
    expect(registryCalls).toBe(1);
    expect((await createBuild()(item)).type).toBe("built");
    expect(registryCalls).toBe(2);
  });

  test("replay retains the typed permanent refusal without inventing a registry record", async () => {
    const observation = {
      status: "unavailable",
      httpStatus: 404,
      reason: "http-refusal",
    } as const;
    const decision = assembleSkCourtsDecision({
      item,
      detail: null,
      courtRegistry: observation,
    });
    expect(decision).not.toBeNull();
    if (decision === null) {
      return;
    }
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(parts?.["court-registry"]).toBeUndefined();
    expect(JSON.parse(parts?.["court-registry-unavailable"] ?? "null")).toEqual(
      observation,
    );
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
    expect(outcome.result.metadata["courtRegistry"]).toEqual(observation);
    expect(outcome.result.rawHash).toBe(decision.rawHash);
  });

  test("replay retains registry enrichment, aliases, raw fields, and its hash", async () => {
    const record = { ...registry, publisherExtra: "kept in raw" };
    const decision = assembleSkCourtsDecision({
      item,
      detail: null,
      courtRegistry: { status: "available", record },
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
    expect(outcome.result.metadata["courtSuccession"]).toMatchObject({
      eli: "eli/sk/zz/2004/371",
      version: "2023-06-01",
    });
    expect(outcome.result.metadata).toEqual(decision.metadata);
    expect(outcome.result.rawHash).toBe(decision.rawHash);
  });
});
