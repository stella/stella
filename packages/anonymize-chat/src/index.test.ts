import { describe, expect, test } from "bun:test";

import type {
  GazetteerEntry,
  NativeAnonymizeBinding,
  NativePipelineEntity,
  NativeStaticRedactionResult,
  PipelineConfig,
} from "@stll/anonymize-wasm";

import {
  buildChatAnonPipelineConfig,
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
  DEFAULT_CHAT_ANON_ENTITY_LABELS,
  createThirdPartyBoundaryRefusalPayload,
  findChatAnonPlaceholders,
  FORCED_SENSITIVE_VALUES_MAX,
  FORCED_SENSITIVE_VALUE_MAX_LENGTH,
  getPreferredChatSendMode,
  isThirdPartyBoundaryRefusalError,
  isThirdPartyBoundaryRefusalPayload,
  normalizeChatAnonLocaleLanguage,
  parseChatTransportErrorMessage,
  parseChatTransportErrorPayload,
  runChatAnonPipeline,
} from "./index";
import type { ChatAnonRuntime } from "./index";

describe("chat anonymization pipeline contract", () => {
  test("builds the shared client/server chat pipeline shape", () => {
    expect(
      buildChatAnonPipelineConfig({
        hasGazetteer: true,
        workspaceId: "workspace-A",
      }),
    ).toEqual({
      threshold: 0.4,
      enableTriggerPhrases: true,
      enableRegex: true,
      enableNameCorpus: true,
      enableDenyList: false,
      enableGazetteer: true,
      enableConfidenceBoost: false,
      enableCoreference: true,
      enableLegalForms: true,
      labels: [...DEFAULT_CHAT_ANON_ENTITY_LABELS],
      workspaceId: "workspace-A",
    });
  });

  test("maps supported locales to pipeline scopes and preserves the all-language fallback", () => {
    expect(normalizeChatAnonLocaleLanguage("pt_BR-u-nu-latn")).toBe("pt-br");
    expect(normalizeChatAnonLocaleLanguage("en-US")).toBe("en");
    expect(normalizeChatAnonLocaleLanguage("ar")).toBe(null);

    expect(
      buildChatAnonPipelineConfig({
        hasGazetteer: false,
        locale: "pt_BR",
        workspaceId: "workspace-A",
      }),
    ).toMatchObject({ nameCorpusLanguages: ["pt-br"] });
    expect(
      buildChatAnonPipelineConfig({
        hasGazetteer: false,
        locale: "ar",
        workspaceId: "workspace-A",
      }),
    ).not.toHaveProperty("nameCorpusLanguages");
  });

  test("parses only the shared chat transport error payload shape", () => {
    const payload = createThirdPartyBoundaryRefusalPayload("blocked");

    expect(parseChatTransportErrorPayload(payload)).toEqual({
      code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
      message: "blocked",
    });
    expect(parseChatTransportErrorMessage(JSON.stringify(payload))).toEqual(
      payload,
    );
    expect(isThirdPartyBoundaryRefusalPayload(payload)).toBe(true);
    expect(
      isThirdPartyBoundaryRefusalError(
        new Error(JSON.stringify(createThirdPartyBoundaryRefusalPayload("x"))),
      ),
    ).toBe(true);
    expect(
      parseChatTransportErrorPayload({ code: "other", message: "x" }),
    ).toBe(null);
  });

  test("models raw override as a first-class send mode", () => {
    expect(getPreferredChatSendMode(false)).toBe(CHAT_SEND_MODE.rawOverride);
    expect(getPreferredChatSendMode(true)).toBe(CHAT_SEND_MODE.anonymized);
  });

  test("distinguishes allowed source placeholders from unknown response tokens", () => {
    const sourcePlaceholders = findChatAnonPlaceholders(
      "Keep literal [CASE_NUMBER_7].",
    );
    const allowedPlaceholders = new Set([...sourcePlaceholders, "[PERSON_1]"]);
    const responsePlaceholders = findChatAnonPlaceholders(
      "[CASE_NUMBER_7] [PERSON_1] [LOCATION_2] [LOCATION_2] [not_a_token]",
    );

    expect(sourcePlaceholders).toEqual(["[CASE_NUMBER_7]"]);
    expect(
      responsePlaceholders.filter(
        (placeholder) => !allowedPlaceholders.has(placeholder),
      ),
    ).toEqual(["[LOCATION_2]"]);
  });
});

describe("runChatAnonPipeline excludedCanonicals", () => {
  type FakePipeline = {
    redactText: (fullText: string) => NativeStaticRedactionResult;
  };

  type BuildRuntimeOptions = {
    inspectGazetteerEntries?: (entries: readonly GazetteerEntry[]) => void;
    inspectRedactionInput?: (text: string) => void;
  };

  /**
   * Build a `ChatAnonRuntime` test double whose `redactText` splices
   * entity spans right-to-left, matching the native offset contract
   * closely enough to exercise exclusion and placeholder invariants
   * without a real wasm binding.
   */
  const buildRuntime = (
    entities: NativePipelineEntity[],
    {
      inspectGazetteerEntries,
      inspectRedactionInput,
    }: BuildRuntimeOptions = {},
  ): ChatAnonRuntime => ({
    // SAFETY: the mock binding value is opaque plumbing - the fake
    // `createNativePipelineFromConfig` below never inspects it, it
    // only forwards it to `redactText`'s closure over `entities`.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double stands in for the real wasm binding
    getBinding: async () => ({}) as NativeAnonymizeBinding,
    createPipelineContext: () => ({
      nativePipelinePackage: null,
      nativePipelinePackageKey: "",
      nativePipelinePackagePromise: null,
    }),
    createNativePipelineFromConfig: async ({ gazetteerEntries }) => {
      inspectGazetteerEntries?.(gazetteerEntries ?? []);
      const pipeline: FakePipeline = {
        redactText: (fullText) => {
          inspectRedactionInput?.(fullText);
          const redactionMap = new Map<string, string>();
          const operatorMap = new Map<string, "replace">();
          const resolvedEntities = entities.map((entity) => {
            const start = fullText.indexOf(entity.text);
            return {
              end: start + entity.text.length,
              label: entity.label,
              score: entity.score,
              source: entity.source,
              start,
              text: entity.text,
            };
          });
          const replacements = resolvedEntities.map((entity, idx) => {
            const placeholderLabel = entity.label
              .trim()
              .toUpperCase()
              .replaceAll(/\s+/gu, "_");
            const placeholder = `[${placeholderLabel}_${idx + 1}]`;
            redactionMap.set(placeholder, entity.text);
            operatorMap.set(placeholder, "replace");
            return {
              end: entity.end,
              placeholder,
              start: entity.start,
            };
          });
          let redactedText = fullText;
          for (const replacement of replacements.toSorted(
            (left, right) => right.start - left.start,
          )) {
            redactedText =
              redactedText.slice(0, replacement.start) +
              replacement.placeholder +
              redactedText.slice(replacement.end);
          }
          return {
            resolvedEntities,
            redaction: {
              redactedText,
              redactionMap,
              operatorMap,
              entityCount: entities.length,
            },
          };
        },
      };
      // SAFETY: only `redactText` is exercised by these tests; the
      // rest of `PreparedNativePipeline`'s surface is intentionally
      // left unimplemented on this test double.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double only implements `redactText`
      return pipeline as unknown as Awaited<
        ReturnType<ChatAnonRuntime["createNativePipelineFromConfig"]>
      >;
    },
    deanonymise: (redactedText, redactionMap) => {
      let result = redactedText;
      for (const [placeholder, original] of redactionMap) {
        result = result.replaceAll(placeholder, () => original);
      }
      return result;
    },
  });

  const dictionaries = {} as NonNullable<PipelineConfig["dictionaries"]>;

  const makeEntity = (text: string, label: string): NativePipelineEntity => ({
    start: 0,
    end: text.length,
    label,
    text,
    score: 1,
    source: "regex",
  });

  test("reverts entities whose normalized text matches an excluded canonical", async () => {
    const entities: NativePipelineEntity[] = [
      makeEntity("Acme Corp", "organization"),
      makeEntity("Jane Doe", "person"),
    ];
    const runtime = buildRuntime(entities);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: "Acme Corp employs Jane Doe",
      workspaceId: "ws-1",
      excludedCanonicals: ["acme  corp"],
    });

    expect(result.pairs.map((p) => p.original)).toEqual(["Jane Doe"]);
    expect(result.entityCount).toBe(1);
    expect(result.redactedText).toBe("Acme Corp employs [PERSON_2]");
  });

  test("normalizes excluded canonicals NFKC + case-insensitive", async () => {
    const canonical = "Café Élysée";
    const entities: NativePipelineEntity[] = [
      makeEntity(canonical, "organization"),
    ];
    const runtime = buildRuntime(entities);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: canonical,
      workspaceId: "ws-1",
      // Compatibility-decomposed form ("Cafe" + combining acute)
      // with mixed case should still collide with the canonical
      // (precomposed, capitalized) form above after NFKC.
      excludedCanonicals: ["café élysée"],
    });

    expect(result.pairs).toEqual([]);
    expect(result.entityCount).toBe(0);
    expect(result.redactedText).toBe(canonical);
  });

  test("preserves literal placeholders while reverting excluded canonicals", async () => {
    const entities: NativePipelineEntity[] = [makeEntity("Alice", "person")];
    const runtime = buildRuntime(entities);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: "[PERSON_1] and Alice",
      workspaceId: "ws-1",
      excludedCanonicals: ["alice"],
    });

    expect(result.pairs).toEqual([]);
    expect(result.entityCount).toBe(0);
    expect(result.redactedText).toBe("[PERSON_1] and Alice");
  });

  test("forces exact values through the native placeholder allocation", async () => {
    const forcedValue = "ORDER-123";
    let receivedEntries: readonly GazetteerEntry[] = [];
    const runtime = buildRuntime([makeEntity(forcedValue, "misc")], {
      inspectGazetteerEntries: (entries) => {
        receivedEntries = entries;
      },
    });

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: `${forcedValue} is selected`,
      workspaceId: "ws-1",
      forcedSensitiveValues: [forcedValue],
    });

    expect(receivedEntries).toContainEqual({
      id: "forced-sensitive-1",
      canonical: forcedValue,
      label: "misc",
      variants: [],
      workspaceId: "ws-1",
      createdAt: 0,
      source: "manual",
    });
    expect(result.redactedText).toBe("[MISC_1] is selected");
    expect(result.redactionMap).toEqual(new Map([["[MISC_1]", forcedValue]]));
  });

  test("forced values override exclusions without becoming their own placeholder", async () => {
    const forcedValue = "[MISC_1]";
    const runtime = buildRuntime([makeEntity(forcedValue, "case number")]);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: forcedValue,
      workspaceId: "ws-1",
      excludedCanonicals: [forcedValue],
      forcedSensitiveValues: [forcedValue],
    });

    expect(result.redactedText).toBe("[CASE_NUMBER_1]");
    expect(result.redactionMap).toEqual(
      new Map([["[CASE_NUMBER_1]", forcedValue]]),
    );
  });

  test("preserves forced values containing placeholder-shaped substrings", async () => {
    const forcedValue = "Matter [CASE_123]";
    const runtime = buildRuntime([makeEntity(forcedValue, "misc")]);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: forcedValue,
      workspaceId: "ws-1",
      forcedSensitiveValues: [forcedValue],
    });

    expect(result.redactedText).toBe("[MISC_1]");
    expect(result.redactionMap).toEqual(new Map([["[MISC_1]", forcedValue]]));
  });

  test("does not restore an excluded entity containing a forced value", async () => {
    const forcedValue = "ORDER-123";
    const excludedValue = `Matter ${forcedValue}`;
    const runtime = buildRuntime([makeEntity(excludedValue, "organization")]);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: excludedValue,
      workspaceId: "ws-1",
      excludedCanonicals: [excludedValue],
      forcedSensitiveValues: [forcedValue],
    });

    expect(result.redactedText).toBe("[ORGANIZATION_1]");
    expect(result.redactionMap).toEqual(
      new Map([["[ORGANIZATION_1]", excludedValue]]),
    );
  });

  test("applies forced precedence per normalized exclusion occurrence", async () => {
    const forcedValue = "ORDER-123";
    const exact = `Matter ${forcedValue}`;
    const caseVariant = "matter order-123";
    const runtime = buildRuntime([
      makeEntity(exact, "organization"),
      makeEntity(caseVariant, "organization"),
    ]);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: `${exact}; ${caseVariant}`,
      workspaceId: "ws-1",
      excludedCanonicals: [exact],
      forcedSensitiveValues: [forcedValue],
    });

    expect(result.redactedText).toBe(`[ORGANIZATION_1]; ${caseVariant}`);
    expect(result.redactionMap).toEqual(new Map([["[ORGANIZATION_1]", exact]]));
    expect(result.entityCount).toBe(1);
  });

  test("restores a normalized exclusion beside an exact forced value", async () => {
    const forcedValue = "ORDER-123";
    const caseVariant = "order-123";
    const runtime = buildRuntime([
      makeEntity(forcedValue, "misc"),
      makeEntity(caseVariant, "misc"),
    ]);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: `${forcedValue}; ${caseVariant}`,
      workspaceId: "ws-1",
      excludedCanonicals: [caseVariant],
      forcedSensitiveValues: [forcedValue],
    });

    expect(result.redactedText).toBe(`[MISC_1]; ${caseVariant}`);
    expect(result.redactionMap).toEqual(new Map([["[MISC_1]", forcedValue]]));
    expect(result.entityCount).toBe(1);
  });

  test("keeps forced values from colliding with literal-placeholder sentinels", async () => {
    const forcedValue = "CHAT_PLACEHOLDER_0";
    const runtime = buildRuntime([makeEntity(forcedValue, "misc")]);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: `[PERSON_1] ${forcedValue}`,
      workspaceId: "ws-1",
      forcedSensitiveValues: [forcedValue],
    });

    expect(result.redactedText).toBe("[PERSON_1] [MISC_1]");
    expect(result.redactionMap).toEqual(new Map([["[MISC_1]", forcedValue]]));
  });

  test("keeps gazetteer terms from colliding with literal-placeholder sentinels", async () => {
    const gazetteerVariant = "\uE000";
    let receivedInput = "";
    const runtime = buildRuntime([], {
      inspectRedactionInput: (text) => {
        receivedInput = text;
      },
    });

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: "[PERSON_1]",
      workspaceId: "ws-1",
      gazetteerEntries: [
        {
          id: "term-1",
          canonical: "other",
          label: "misc",
          variants: [gazetteerVariant],
          workspaceId: "ws-1",
          createdAt: 0,
          source: "manual",
        },
      ],
    });

    expect(receivedInput).not.toContain(gazetteerVariant);
    expect(result.redactedText).toBe("[PERSON_1]");
    expect(result.redactionMap).toEqual(new Map());
  });

  test("rekeys generated placeholders reserved by literal source text", async () => {
    const forcedValue = "Alice";
    const runtime = buildRuntime([makeEntity(forcedValue, "misc")]);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: `[MISC_1] ${forcedValue}`,
      workspaceId: "ws-1",
      forcedSensitiveValues: [forcedValue],
    });

    expect(result.redactedText).toBe("[MISC_1] [MISC_2]");
    expect(result.redactionMap).toEqual(new Map([["[MISC_2]", forcedValue]]));
    expect(runtime.deanonymise(result.redactedText, result.redactionMap)).toBe(
      `[MISC_1] ${forcedValue}`,
    );
  });

  test("fails closed when native redaction leaves a forced value", () => {
    const forcedValue = "ORDER-123";
    const runtime = buildRuntime([]);

    expect(
      runChatAnonPipeline({
        runtime,
        dictionaries,
        text: forcedValue,
        workspaceId: "ws-1",
        forcedSensitiveValues: [forcedValue],
      }),
    ).rejects.toThrow("forced sensitive value remained after anonymization");
  });

  test("fails closed when a resolved entity covers only part of a forced value", () => {
    const forcedValue = "ORDER-123";
    const runtime = buildRuntime([makeEntity("XORDER", "misc")]);

    expect(
      runChatAnonPipeline({
        runtime,
        dictionaries,
        text: `X${forcedValue}`,
        workspaceId: "ws-1",
        forcedSensitiveValues: [forcedValue],
      }),
    ).rejects.toThrow("forced sensitive value remained after anonymization");
  });

  test("accepts self-overlapping forced occurrences removed by one full span", async () => {
    const forcedValue = "aaa";
    const runtime = buildRuntime([makeEntity(forcedValue, "misc")]);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: "aaaa",
      workspaceId: "ws-1",
      forcedSensitiveValues: [forcedValue],
    });

    expect(result.redactedText).toBe("[MISC_1]a");
    expect(result.redactionMap).toEqual(new Map([["[MISC_1]", forcedValue]]));
  });

  test("rejects a self-overlapping forced run with an uncovered occurrence", () => {
    const forcedValue = "aaa";
    const runtime = buildRuntime([makeEntity(forcedValue, "misc")]);

    expect(
      runChatAnonPipeline({
        runtime,
        dictionaries,
        text: "aaaaaa",
        workspaceId: "ws-1",
        forcedSensitiveValues: [forcedValue],
      }),
    ).rejects.toThrow("forced sensitive value remained after anonymization");
  });

  test("accepts forced source text contained only in generated placeholders", async () => {
    const forcedValue = "MISC";
    const runtime = buildRuntime([makeEntity(forcedValue, "misc")]);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: forcedValue,
      workspaceId: "ws-1",
      forcedSensitiveValues: [forcedValue],
    });

    expect(result.redactedText).toBe("[MISC_1]");
    expect(result.redactionMap).toEqual(new Map([["[MISC_1]", forcedValue]]));
  });

  test("rekeys cyclic forced-placeholder allocations without breaking round trips", async () => {
    const firstForcedValue = "[MISC_2]";
    const secondForcedValue = "[CASE_NUMBER_1]";
    const runtime = buildRuntime([
      makeEntity(firstForcedValue, "case number"),
      makeEntity(secondForcedValue, "misc"),
    ]);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: `${firstForcedValue} ${secondForcedValue}`,
      workspaceId: "ws-1",
      forcedSensitiveValues: [firstForcedValue, secondForcedValue],
    });

    expect(result.redactedText).toBe("[CASE_NUMBER_2] [MISC_1]");
    expect(result.redactionMap).toEqual(
      new Map([
        ["[CASE_NUMBER_2]", firstForcedValue],
        ["[MISC_1]", secondForcedValue],
      ]),
    );
    expect(runtime.deanonymise(result.redactedText, result.redactionMap)).toBe(
      `${firstForcedValue} ${secondForcedValue}`,
    );
  });

  test("bounds caller-supplied forced values before building a pipeline", () => {
    const runtime = buildRuntime([]);

    expect(
      runChatAnonPipeline({
        runtime,
        dictionaries,
        text: "sensitive",
        workspaceId: "ws-1",
        forcedSensitiveValues: Array.from(
          { length: FORCED_SENSITIVE_VALUES_MAX + 1 },
          (_, index) => `sensitive-${String(index)}`,
        ),
      }),
    ).rejects.toBeInstanceOf(RangeError);

    expect(
      runChatAnonPipeline({
        runtime,
        dictionaries,
        text: "sensitive",
        workspaceId: "ws-1",
        forcedSensitiveValues: [
          "x".repeat(FORCED_SENSITIVE_VALUE_MAX_LENGTH + 1),
        ],
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  test("passes all entities through when no exclusions are provided", async () => {
    const entities: NativePipelineEntity[] = [
      makeEntity("Acme Corp", "organization"),
    ];
    const runtime = buildRuntime(entities);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: "Acme Corp",
      workspaceId: "ws-1",
    });

    expect(result.pairs.map((p) => p.original)).toEqual(["Acme Corp"]);
    expect(result.entityCount).toBe(1);
    expect(result.redactedText).toBe("[ORGANIZATION_1]");
  });

  test("labels same-text pairs from the placeholder prefix", async () => {
    const entities: NativePipelineEntity[] = [
      makeEntity("Apple", "organization"),
      makeEntity("Apple", "location"),
    ];
    const runtime = buildRuntime(entities);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: "Apple borders Apple",
      workspaceId: "ws-1",
    });

    expect(result.pairs).toEqual([
      {
        placeholder: "[ORGANIZATION_1]",
        original: "Apple",
        label: "organization",
      },
      {
        placeholder: "[LOCATION_2]",
        original: "Apple",
        label: "location",
      },
    ]);
  });
});
