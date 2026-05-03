import { describe, expect, mock, test } from "bun:test";

import type { ScopedDb } from "@/api/db";
import { toSafeId } from "@/api/lib/branded-types";
import { buildFieldMarkers } from "@/api/mcp/field-markers";

const dictionaries = {
  femaleNames: new Set(["Alice"]),
  maleNames: new Set(["Bob"]),
  surnames: new Set(["Novak"]),
};
const loadNameDictionariesMock = mock(async () => dictionaries);
let capturedDictionaries: unknown;
const runPipelineMock = mock(
  async ({ config }: { config: { dictionaries?: unknown } }) => {
    capturedDictionaries = config.dictionaries;
    return [];
  },
);

void mock.module("@stll/anonymize-data", () => ({
  loadNameDictionaries: loadNameDictionariesMock,
}));

void mock.module("@stll/anonymize-wasm", () => ({
  createPipelineContext: () => ({}),
  DEFAULT_ENTITY_LABELS: ["PERSON"],
  DEFAULT_OPERATOR_CONFIG: {},
  redactText: (fullText: string) => ({
    entityCount: 0,
    redactedText: fullText,
  }),
  runPipeline: runPipelineMock,
}));

void mock.module("@/api/lib/anonymization-blacklist", () => ({
  loadAnonymizationGazetteerEntries: async () => [],
}));

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
    const { anonymizeTextFields } = await import("@/api/mcp/anonymization");
    const scopedDb: ScopedDb = async () => {
      throw new Error("Expected gazetteer loader mock to avoid DB access");
    };
    capturedDictionaries = undefined;

    await anonymizeTextFields({
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
