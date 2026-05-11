import { describe, expect, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS as WASM_DEFAULT_ENTITY_LABELS } from "@stll/anonymize-wasm";

import {
  buildChatAnonPipelineConfig,
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
  DEFAULT_CHAT_ANON_ENTITY_LABELS,
  createThirdPartyBoundaryRefusalPayload,
  isThirdPartyBoundaryRefusalPayload,
  parseChatTransportErrorMessage,
  parseChatTransportErrorPayload,
} from "./index";

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
      parseChatTransportErrorPayload({ code: "other", message: "x" }),
    ).toBe(null);
  });

  test("models raw override as a first-class send mode", () => {
    expect(CHAT_SEND_MODE).toEqual({
      raw: "raw",
      anonymized: "anonymized",
      rawOverride: "rawOverride",
    });
  });
});
