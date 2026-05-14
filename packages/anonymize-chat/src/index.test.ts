import { describe, expect, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS as WASM_DEFAULT_ENTITY_LABELS,
  DEFAULT_OPERATOR_CONFIG,
} from "@stll/anonymize-wasm";
import type {
  Entity,
  PipelineConfig,
  RedactionResult,
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
      enableNer: false,
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
  const buildRuntime = (
    entities: Entity[],
  ): {
    runtime: ChatAnonRuntime;
    seenEntities: { value: Entity[] };
  } => {
    const seenEntities: { value: Entity[] } = { value: [] };
    const runtime: ChatAnonRuntime = {
      createPipelineContext,
      defaultOperatorConfig: DEFAULT_OPERATOR_CONFIG,
      runPipeline: async () => entities,
      redactText: (text, accepted) => {
        seenEntities.value = accepted;
        const redactionMap = new Map<string, string>();
        const operatorMap = new Map<string, "replace">();
        for (let idx = 0; idx < accepted.length; idx += 1) {
          const entity = accepted[idx];
          if (!entity) {
            continue;
          }
          const placeholder = `[${entity.label.toUpperCase()}_${idx + 1}]`;
          redactionMap.set(placeholder, entity.text);
          operatorMap.set(placeholder, "replace");
        }
        const result: RedactionResult = {
          redactedText: text,
          redactionMap,
          operatorMap,
          entityCount: accepted.length,
        };
        return result;
      },
    };
    return { runtime, seenEntities };
  };

  const dictionaries = {} as NonNullable<PipelineConfig["dictionaries"]>;

  const makeEntity = (text: string, label: string): Entity => ({
    start: 0,
    end: text.length,
    label,
    text,
    score: 1,
    source: "regex",
  });

  test("drops entities whose normalized text matches an excluded canonical", async () => {
    const entities: Entity[] = [
      makeEntity("Acme Corp", "organization"),
      makeEntity("Jane Doe", "person"),
    ];
    const { runtime, seenEntities } = buildRuntime(entities);

    const result = await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: "Acme Corp employs Jane Doe",
      workspaceId: "ws-1",
      excludedCanonicals: ["acme  corp"],
    });

    expect(seenEntities.value.map((e) => e.text)).toEqual(["Jane Doe"]);
    expect(result.pairs.map((p) => p.original)).toEqual(["Jane Doe"]);
    expect(result.entityCount).toBe(1);
  });

  test("normalizes excluded canonicals NFKC + case-insensitive", async () => {
    const entities: Entity[] = [makeEntity("Café Élysée", "organization")];
    const { runtime, seenEntities } = buildRuntime(entities);

    await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: "ignored",
      workspaceId: "ws-1",
      // Compatibility-decomposed form ("Café") with mixed
      // case should still collide with "Café Élysée" after NFKC.
      excludedCanonicals: ["café élysée"],
    });

    expect(seenEntities.value).toEqual([]);
  });

  test("passes all entities through when no exclusions are provided", async () => {
    const entities: Entity[] = [makeEntity("Acme Corp", "organization")];
    const { runtime, seenEntities } = buildRuntime(entities);

    await runChatAnonPipeline({
      runtime,
      dictionaries,
      text: "Acme Corp",
      workspaceId: "ws-1",
    });

    expect(seenEntities.value).toEqual(entities);
  });
});
