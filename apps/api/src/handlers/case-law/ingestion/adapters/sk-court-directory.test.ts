import { afterEach, describe, expect, test } from "bun:test";

import { getSkCourtSuccessionEdges } from "@stll/api-contract/sk-court-succession";

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
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
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
/** The registry's refusal of its record, as the decision stores it. */
const refusedRegistry = (status: 401 | 403) =>
  ({
    status: "refused",
    refusal: {
      type: "refused",
      status,
      scope: "part",
      cause: { kind: "http-status", retryAfter: null },
    },
  }) as const;

/** The registry's statement that it holds no record, as the decision stores it. */
const absentRegistry = (evidence: "http-404" | "http-410") =>
  ({ status: "absent", absence: { type: "absent", evidence } }) as const;

const item = {
  guid: "decision",
  spisovaZnacka: "7C/221/1991",
  sud: {
    registreGuid: registry.registreGuid,
    nazov: "Okresný súd Bratislava I",
  },
};

describe("court registry enrichment", () => {
  test("statute references survive absent or refused registry enrichment and preserve stated names", async () => {
    for (const name of [item.sud.nazov, "Najvyšší súd Slovenskej republiky"]) {
      const listedItem = { ...item, sud: { ...item.sud, nazov: name } };
      for (const observation of [
        undefined,
        { status: "available", record: { ...registry, nazov: name } },
        { status: "unavailable", httpStatus: 404, reason: "http-refusal" },
        { status: "unavailable", httpStatus: 200, reason: "invalid-shape" },
        refusedRegistry(403),
        absentRegistry("http-404"),
      ] as const) {
        const decision = assembleSkCourtsDecision({
          item: listedItem,
          detail: null,
          ...(observation === undefined ? {} : { courtRegistry: observation }),
        });
        const edgeIds = getSkCourtSuccessionEdges()
          .filter(({ from, to }) =>
            [from.registryMatchName, to.registryMatchName].includes(name),
          )
          .map(({ id }) => id);
        expect(edgeIds.length > 0).toBe(name === item.sud.nazov);
        expect(decision?.court === name).toBe(true);
        expect(
          Bun.deepEquals(decision?.metadata["courtSuccession"], {
            eli: "eli/sk/zz/2004/371",
            version: "2023-06-01",
            edgeIds,
          }),
        ).toBe(true);
        expect(decision).not.toBeNull();
        if (decision === null) {
          continue;
        }
        const replay = await skCourtsAdapter.reparseStoredRaw?.({
          raw: new TextEncoder().encode(decision.sourceRaw),
          contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
          caseNumber: listedItem.spisovaZnacka,
          sourceDocumentId: null,
          language: "sk",
          court: name,
          ecli: null,
          decisionDate: null,
          decisionType: null,
          sourceUrl: null,
          documentUrl: null,
          metadata: {},
        });
        expect(replay?.type).toBe("parsed");
        if (replay?.type !== "parsed") {
          continue;
        }
        expect(replay.result.parserVersion).toBe(
          PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
        );
        expect(replay.result.court === name).toBe(true);
        expect(replay.result.metadata).toEqual(decision.metadata);
        expect(replay.result.rawHash).toBe(decision.rawHash);
      }
    }
  });

  test("a different registry name adds only its statute-backed references", () => {
    const record = { ...registry, nazov: "Okresný súd Košice I" };
    const decision = assembleSkCourtsDecision({
      item,
      detail: null,
      courtRegistry: { status: "available", record },
    });
    const idsFor = (name: string) =>
      getSkCourtSuccessionEdges()
        .filter(({ from, to }) =>
          [from.registryMatchName, to.registryMatchName].includes(name),
        )
        .map(({ id }) => id);
    expect(idsFor(record.nazov).length).toBeGreaterThan(0);
    expect(decision?.court === item.sud.nazov).toBe(true);
    expect(decision?.metadata["courtSuccession"]).toMatchObject({
      edgeIds: [
        ...new Set([...idsFor(item.sud.nazov), ...idsFor(record.nazov)]),
      ],
    });
  });

  test("normalizes stated labels and derives only identity-backed aliases", () => {
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
      expect(result?.court === name.trim()).toBe(true);
      expect(result?.metadata["courtRegistry"]).toMatchObject(registry);
      expect(
        Bun.deepEquals(result?.metadata["courtClassification"], {
          status: "classified",
          level: "first-instance",
          jurisdiction: "general",
        }),
      ).toBe(true);
      expect(
        Bun.deepEquals(
          result?.metadata["courtAlias"],
          name === registry.nazov
            ? undefined
            : {
                type: "same-registry-id",
                registreGuid: registry.registreGuid,
                statedName: name.trim(),
                registryName: registry.nazov,
              },
        ),
      ).toBe(true);
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

  test("transient registry failures hold the page and retries recover the right references", async () => {
    for (const name of [item.sud.nazov, "Najvyšší súd Slovenskej republiky"]) {
      const listedItem = { ...item, sud: { ...item.sud, nazov: name } };
      let unavailable = true;
      globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.includes("/v1/sud/")) {
          return unavailable
            ? new Response("unavailable", { status: 503 })
            : new Response(JSON.stringify({ ...registry, nazov: name }));
        }
        if (url.searchParams.has("page")) {
          return new Response(
            JSON.stringify({ numFound: 1, rozhodnutieList: [listedItem] }),
          );
        }
        return new Response(JSON.stringify(listedItem));
      });
      const failed = await skCourtsAdapter.fetchPage(null, {});
      expect(failed.isErr()).toBe(true);
      if (failed.isErr()) {
        expect(failed.error).toBeInstanceOf(AdapterFetchError);
      }
      unavailable = false;
      const retried = await skCourtsAdapter.fetchPage(null, {});
      expect(retried.isOk()).toBe(true);
      if (retried.isErr()) {
        continue;
      }
      const decision = retried.value.decisions.at(0);
      expect(decision?.court === name).toBe(true);
      expect(decision?.metadata["courtSuccession"]).toEqual(
        assembleSkCourtsDecision({ item: listedItem, detail: null })?.metadata[
          "courtSuccession"
        ],
      );
    }
  });

  test("every stored court registry field reaches the content hash", () => {
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
    // The record is stored verbatim, so a field the decision does not read
    // still changes the stored bytes, and with them the fingerprint.
    expect(withPhoto?.rawHash).not.toBe(before?.rawHash);
  });

  test("types refusals and absences, and classifies malformed JSON separately from transient failures", async () => {
    for (const [body, status, observation] of [
      ["unauthorized", 401, refusedRegistry(401)],
      ["forbidden", 403, refusedRegistry(403)],
      ["not found", 404, absentRegistry("http-404")],
      ["gone", 410, absentRegistry("http-410")],
    ] as const) {
      globalThis.fetch = asFetchMock(
        async () => new Response(body, { status }),
      );
      const result = await createSkCourtRegistryReader()(registry.registreGuid);
      expect(result.unwrap()).toEqual(observation);
    }
    for (const [body, status, reason] of [
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
    for (const answer of [
      ...[408, 425, 429, 503].map(
        (status) => () => new Response("retry", { status }),
      ),
      // A served answer with no record states nothing about the court.
      () => new Response(null, { status: 204 }),
      () => new Response(""),
    ]) {
      globalThis.fetch = asFetchMock(
        async () => await Promise.resolve(answer()),
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

  test("a refused, absent or unusable registry record keeps the decision and advances the page", async () => {
    for (const [body, status, observation] of [
      ["unauthorized", 401, refusedRegistry(401)],
      ["forbidden", 403, refusedRegistry(403)],
      ["not found", 404, absentRegistry("http-404")],
      ["gone", 410, absentRegistry("http-410")],
      [
        "<html>not JSON</html>",
        200,
        { status: "unavailable", httpStatus: 200, reason: "invalid-json" },
      ],
      [
        JSON.stringify({ typSudu: 42 }),
        200,
        { status: "unavailable", httpStatus: 200, reason: "invalid-shape" },
      ],
      [
        "x".repeat(1024 * 1024 + 1),
        200,
        {
          status: "unavailable",
          httpStatus: 200,
          reason: "response-too-large",
        },
      ],
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
      expect(decision?.caseNumber === item.spisovaZnacka).toBe(true);
      expect(decision?.court === item.sud.nazov).toBe(true);
      expect(
        Bun.deepEquals(decision?.metadata["courtRegistry"], observation),
      ).toBe(true);
      // A withheld part: the decision itself is complete.
      expect(decision?.isListingOnly).toBeUndefined();
      expect(decision?.metadata["courtSuccession"]).toEqual(
        assembleSkCourtsDecision({ item, detail: null })?.metadata[
          "courtSuccession"
        ],
      );
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

  test.each([
    ["an absence", absentRegistry("http-404")],
    ["a refusal", refusedRegistry(403)],
    [
      "a disposition stored before typed outcomes",
      { status: "unavailable", httpStatus: 404, reason: "http-refusal" },
    ],
  ] as const)(
    "replay retains %s without inventing a registry record",
    async (_label, observation) => {
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
      expect(
        JSON.parse(parts?.["court-registry-unavailable"] ?? "null"),
      ).toEqual(observation);
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
      expect(
        Bun.deepEquals(outcome.result.metadata["courtRegistry"], observation),
      ).toBe(true);
      expect(outcome.result.metadata["courtSuccession"]).toMatchObject({
        eli: "eli/sk/zz/2004/371",
        edgeIds: expect.arrayContaining([expect.any(String)]),
      });
      expect(outcome.result.parserVersion).toBe(
        PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
      );
      expect(outcome.result.rawHash).toBe(decision.rawHash);
    },
  );

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
    expect(outcome.result.parserVersion).toBe(
      PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
    );
    expect(outcome.result.rawHash).toBe(decision.rawHash);
  });
});
