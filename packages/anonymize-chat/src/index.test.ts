import { describe, expect, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS as WASM_DEFAULT_ENTITY_LABELS } from "@stll/anonymize-wasm";

import {
  buildChatAnonPipelineConfig,
  DEFAULT_CHAT_ANON_ENTITY_LABELS,
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
});
