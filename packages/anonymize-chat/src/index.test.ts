import { describe, expect, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS as WASM_DEFAULT_ENTITY_LABELS } from "@stll/anonymize-wasm";
import type {
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
  getPreferredChatSendMode,
  isThirdPartyBoundaryRefusalError,
  isThirdPartyBoundaryRefusalPayload,
  parseChatTransportErrorMessage,
  parseChatTransportErrorPayload,
  runChatAnonPipeline,
} from "./index";
import type { ChatAnonRuntime } from "./index";

describe("chat anonymization pipeline contract", () => {
  test("keeps hardcoded labels aligned with the wasm package", () => {
    expect([...DEFAULT_CHAT_ANON_ENTITY_LABELS]).toEqual([
      ...WASM_DEFAULT_ENTITY_LABELS,
    ]);
  });

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
    expect(CHAT_SEND_MODE).toEqual({
      anonymized: "anonymized",
      rawOverride: "rawOverride",
    });
    expect(getPreferredChatSendMode(false)).toBe(CHAT_SEND_MODE.rawOverride);
    expect(getPreferredChatSendMode(true)).toBe(CHAT_SEND_MODE.anonymized);
  });
});

describe("runChatAnonPipeline excludedCanonicals", () => {
  type FakePipeline = {
    redactText: (fullText: string) => NativeStaticRedactionResult;
  };

  /**
   * Build a `ChatAnonRuntime` test double whose `redactText` performs
   * a naive, entity-order text replacement - good enough to exercise
   * the post-hoc excluded-canonicals revert without a real wasm
   * binding.
   */
  const buildRuntime = (entities: NativePipelineEntity[]): ChatAnonRuntime => ({
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
    createNativePipelineFromConfig: async () => {
      const pipeline: FakePipeline = {
        redactText: (fullText) => {
          const redactionMap = new Map<string, string>();
          const operatorMap = new Map<string, "replace">();
          let redactedText = fullText;
          for (const [idx, entity] of entities.entries()) {
            const placeholder = `[${entity.label.toUpperCase()}_${idx + 1}]`;
            redactedText = redactedText.replaceAll(
              entity.text,
              () => placeholder,
            );
            redactionMap.set(placeholder, entity.text);
            operatorMap.set(placeholder, "replace");
          }
          return {
            resolvedEntities: entities,
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
