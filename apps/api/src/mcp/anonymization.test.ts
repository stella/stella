import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { createPipelineContext } from "@stll/anonymize";
import type { NativeAnonymizeBinding, PipelineConfig } from "@stll/anonymize";

import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import type { AnonymizeTextFieldsDependencies } from "@/api/mcp/anonymization-core";
import { anonymizeTextFieldsWithDependencies } from "@/api/mcp/anonymization-core";
import {
  AnonymizedFieldBoundaryError,
  RESERVED_TOKEN_PLANE,
} from "@/api/mcp/field-markers";
import {
  createRewritingAnonymizeDependencies,
  replaceFirstFieldDelimiterToken,
} from "@/api/tests/helpers/anonymize-pipeline-fakes";

const dictionaries = {
  firstNames: {
    en: ["Alice"],
  },
  surnames: {
    en: ["Novak"],
  },
};

const anonymizeWith = async (
  dependencies: AnonymizeTextFieldsDependencies,
  fields: string[],
) =>
  await anonymizeTextFieldsWithDependencies({
    catalogs: {
      type: "preloaded",
      excludedCanonicals: [],
      gazetteerEntries: [],
    },
    dependencies,
    fields,
    organizationId: toSafeId<"organization">("org_test"),
    workspaceId: "00000000-0000-4000-8000-000000000001",
  });

describe("anonymizing several fields in one call", () => {
  test("returns every field unchanged when the pipeline keeps the text", async () => {
    const fields = [
      "Title",
      "",
      "  ",
      "Body [[[__stella_mcp_anonymized_field_00000000-0000-7000-8000-000000000000_1__]]] tail",
      `Private use ${String.fromCodePoint(RESERVED_TOKEN_PLANE.fieldDelimiter.start)} inside`,
    ];

    const result = await anonymizeWith(
      createRewritingAnonymizeDependencies((text) => text),
      fields,
    );

    expect(Result.isOk(result) ? result.value.fields : result.error).toEqual(
      fields,
    );
  });

  test("refuses output whose field delimiter was replaced by a placeholder", async () => {
    // A typed error result the callers turn into a refusal, not a panic.
    const result = await anonymizeWith(
      createRewritingAnonymizeDependencies((text) =>
        replaceFirstFieldDelimiterToken(text, "[ORGANIZATION_1]"),
      ),
      ["Title", "Body"],
    );

    expect(Result.isError(result) ? result.error : result.value).toBeInstanceOf(
      AnonymizedFieldBoundaryError,
    );
  });

  test("refuses output that lost the line break around a field delimiter", async () => {
    const result = await anonymizeWith(
      createRewritingAnonymizeDependencies((text) =>
        text.replace("Title\n", "[ORGANIZATION_1]"),
      ),
      ["Title", "Body"],
    );

    expect(Result.isError(result) ? result.error : result.value).toBeInstanceOf(
      AnonymizedFieldBoundaryError,
    );
  });
});

describe("anonymizeTextFields", () => {
  test("injects name dictionaries into the API anonymization pipeline", async () => {
    let capturedDictionaries: unknown;
    let gazetteerScope: unknown;
    const loadNameDictionariesMock: AnonymizeTextFieldsDependencies["loadNameDictionaries"] =
      mock(async () => dictionaries);
    // SAFETY: this test double never touches the actual binding
    // value — it only exists to satisfy `createNativePipelineFromConfig`'s
    // `binding` parameter before it is passed through unread.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double stands in for the real wasm binding
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
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double only implements `redactText`
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
      loadAnonymizationGazetteerEntries: async ({ scope }) => {
        gazetteerScope = scope;
        return [];
      },
      loadAnonymizationAllowlistCanonicals: async () => [],
      loadNameDictionaries: loadNameDictionariesMock,
    } satisfies AnonymizeTextFieldsDependencies;
    const scopedDb: ScopedDb = async () => {
      throw new Error("Expected gazetteer loader mock to avoid DB access");
    };

    await anonymizeTextFieldsWithDependencies({
      catalogs: { type: "database", scopedDb },
      dependencies,
      fields: ["Alice Novak"],
      organizationId: toSafeId<"organization">("org_test"),
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });

    expect(loadNameDictionariesMock).toHaveBeenCalledTimes(1);
    expect(gazetteerScope).toEqual({
      type: "workspace",
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });
    expect(createNativePipelineFromConfigMock).toHaveBeenCalledTimes(1);
    expect(capturedDictionaries).toBe(dictionaries);

    gazetteerScope = "not-called";
    await anonymizeTextFieldsWithDependencies({
      catalogs: { type: "database", scopedDb },
      dependencies,
      fields: ["Alice Novak"],
      organizationId: toSafeId<"organization">("org_test"),
      workspaceId: "org_test",
    });

    expect(gazetteerScope).toEqual({ type: "organization" });
  });
});
