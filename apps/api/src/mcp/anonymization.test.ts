import { createPipelineContext } from "@stll/anonymize-wasm";
import { describe, expect, mock, test } from "bun:test";

import type { ScopedDb } from "@/api/db";
import { toSafeId } from "@/api/lib/branded-types";
import type { AnonymizeTextFieldsDependencies } from "@/api/mcp/anonymization";
import { anonymizeTextFieldsWithDependencies } from "@/api/mcp/anonymization";
import { buildFieldMarkers } from "@/api/mcp/field-markers";

const dictionaries = {
  firstNames: {
    en: ["Alice"],
  },
  surnames: {
    en: ["Novak"],
  },
};

describe("anonymizeTextFields", () => {
  test("regenerates markers when crafted content contains a candidate delimiter", async () => {
    const collidingMarker =
      "[[[__stella_mcp_anonymized_field_00000000-0000-4000-8000-000000000001_1__]]]";
    const uuidSequence = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    let randomUUIDCallCount = 0;

    const markers = buildFieldMarkers({
      fieldCount: 2,
      fields: ["Title", `Body ${collidingMarker} tail`],
      randomUUID: () => {
        randomUUIDCallCount += 1;
        const next = uuidSequence.shift();
        if (next === undefined) {
          throw new Error("Expected another UUID");
        }

        return next;
      },
    });

    expect(randomUUIDCallCount).toBe(2);
    expect(markers).toEqual([
      "[[[__stella_mcp_anonymized_field_00000000-0000-4000-8000-000000000002_0__]]]",
      "[[[__stella_mcp_anonymized_field_00000000-0000-4000-8000-000000000002_1__]]]",
    ]);
  });

  test("injects name dictionaries into the API anonymization pipeline", async () => {
    let capturedDictionaries: unknown;
    const loadNameDictionariesMock: AnonymizeTextFieldsDependencies["loadNameDictionaries"] =
      mock(async () => dictionaries);
    const runPipelineMock: AnonymizeTextFieldsDependencies["runPipeline"] =
      mock(async ({ config }) => {
        capturedDictionaries = config.dictionaries;
        return [];
      });
    const dependencies = {
      createPipelineContext,
      loadAnonymizationGazetteerEntries: async () => [],
      loadNameDictionaries: loadNameDictionariesMock,
      redactText: (fullText: string) => ({
        entityCount: 0,
        operatorMap: new Map(),
        redactionMap: new Map(),
        redactedText: fullText,
      }),
      runPipeline: runPipelineMock,
    } satisfies AnonymizeTextFieldsDependencies;
    const scopedDb: ScopedDb = async () => {
      throw new Error("Expected gazetteer loader mock to avoid DB access");
    };

    await anonymizeTextFieldsWithDependencies({
      dependencies,
      fields: ["Alice Novak"],
      organizationId: toSafeId<"organization">("org_test"),
      scopedDb,
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });

    expect(loadNameDictionariesMock).toHaveBeenCalledTimes(1);
    expect(runPipelineMock).toHaveBeenCalledTimes(1);
    expect(capturedDictionaries).toBe(dictionaries);
  });
});
