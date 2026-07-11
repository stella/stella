import { describe, expect, mock, test } from "bun:test";

import { createPipelineContext } from "@stll/anonymize-wasm";
import type {
  NativeAnonymizeBinding,
  PipelineConfig,
} from "@stll/anonymize-wasm";

import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import type { AnonymizeTextFieldsDependencies } from "@/api/mcp/anonymization-core";
import { anonymizeTextFieldsWithDependencies } from "@/api/mcp/anonymization-core";
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
    let gazetteerWorkspaceId: unknown;
    const loadNameDictionariesMock: AnonymizeTextFieldsDependencies["loadNameDictionaries"] =
      mock(async () => dictionaries);
    // SAFETY: this test double never touches the actual binding
    // value — it only exists to satisfy `createNativePipelineFromConfig`'s
    // `binding` parameter before it is passed through unread.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double stands in for the real wasm binding
    const fakeBinding = {} as NativeAnonymizeBinding;
    const createNativePipelineFromConfigMock: AnonymizeTextFieldsDependencies["createNativePipelineFromConfig"] =
      mock(async ({ config }: { config: PipelineConfig }) => {
        capturedDictionaries = config.dictionaries;
        const pipeline = {
          redactText: (fullText: string) => ({
            resolvedEntities: [],
            redaction: {
              entityCount: 0,
              operatorMap: new Map(),
              redactionMap: new Map(),
              redactedText: fullText,
            },
          }),
        };
        // SAFETY: only `redactText` is exercised by this test.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double only implements `redactText`
        return pipeline as unknown as Awaited<
          ReturnType<
            AnonymizeTextFieldsDependencies["createNativePipelineFromConfig"]
          >
        >;
      });
    const dependencies = {
      getBinding: async () => fakeBinding,
      createNativePipelineFromConfig: createNativePipelineFromConfigMock,
      createPipelineContext,
      deanonymise: (redactedText: string) => redactedText,
      loadAnonymizationGazetteerEntries: async ({ workspaceId }) => {
        gazetteerWorkspaceId = workspaceId;
        return [];
      },
      loadAnonymizationAllowlistCanonicals: async () => [],
      loadNameDictionaries: loadNameDictionariesMock,
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
    expect(gazetteerWorkspaceId).toBe("00000000-0000-4000-8000-000000000001");
    expect(createNativePipelineFromConfigMock).toHaveBeenCalledTimes(1);
    expect(capturedDictionaries).toBe(dictionaries);

    gazetteerWorkspaceId = "not-called";
    await anonymizeTextFieldsWithDependencies({
      dependencies,
      fields: ["Alice Novak"],
      organizationId: toSafeId<"organization">("org_test"),
      scopedDb,
      workspaceId: "org_test",
    });

    expect(gazetteerWorkspaceId).toBeUndefined();
  });
});
