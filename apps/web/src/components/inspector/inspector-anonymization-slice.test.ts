import { beforeEach, describe, expect, test } from "bun:test";

import { useInspectorAnonymizationStore } from "@/components/inspector/inspector-anonymization-store";

beforeEach(() => {
  useInspectorAnonymizationStore.setState({
    anonymizationActiveMountCount: 0,
    documentTextSelectionByFieldId: {},
    anonymizationMatchesByFieldId: {},
    anonymizationPipelineStatusByFieldId: {},
    anonymizationRetryByFieldId: {},
    anonymizationSelection: {
      canonical: null,
      label: null,
      source: null,
      fieldId: null,
      seq: 0,
    },
  });
});

describe("inspector anonymization state", () => {
  test("the active mount count never becomes negative", () => {
    const state = useInspectorAnonymizationStore.getState();
    state.acquireAnonymizationActive();
    state.releaseAnonymizationActive();
    state.releaseAnonymizationActive();

    expect(
      useInspectorAnonymizationStore.getState().anonymizationActiveMountCount,
    ).toBe(0);
  });

  test("only successful completion makes a scan ready", () => {
    const state = useInspectorAnonymizationStore.getState();
    const status = () =>
      useInspectorAnonymizationStore.getState()
        .anonymizationPipelineStatusByFieldId["field-1"] ?? "idle";
    expect(status()).toBe("idle");
    state.publishAnonymizationMatches("field-1", {
      totalMatches: 0,
      countByCanonical: new Map(),
      labelByCanonical: new Map(),
    });
    expect(status()).toBe("idle");
    state.markAnonymizationPipelineStarted("field-1");
    expect(status()).toBe("running");
    state.markAnonymizationPipelineFailed("field-1");
    expect(status()).toBe("error");
    state.retryAnonymizationPipeline("field-1");
    expect(status()).toBe("idle");
    expect(
      useInspectorAnonymizationStore.getState().anonymizationRetryByFieldId[
        "field-1"
      ],
    ).toBe(1);
    state.markAnonymizationPipelineStarted("field-1");
    state.markAnonymizationPipelineRan("field-1");
    expect(status()).toBe("ready");
    state.clearAnonymizationMatches("field-1");
    expect(status()).toBe("idle");
    expect(
      useInspectorAnonymizationStore.getState().anonymizationRetryByFieldId,
    ).toEqual({});
  });

  test("pipeline transitions are idempotent and isolated by document", () => {
    const state = useInspectorAnonymizationStore.getState();
    state.markAnonymizationPipelineStarted("field-1");
    const running = useInspectorAnonymizationStore.getState();
    state.markAnonymizationPipelineStarted("field-1");
    expect(useInspectorAnonymizationStore.getState()).toBe(running);
    state.markAnonymizationPipelineStarted("field-2");
    state.markAnonymizationPipelineFailed("field-1");
    state.clearAnonymizationMatches("field-1");
    expect(
      useInspectorAnonymizationStore.getState()
        .anonymizationPipelineStatusByFieldId,
    ).toEqual({ "field-2": "running" });
  });

  test("repeated selections remain observable", () => {
    const state = useInspectorAnonymizationStore.getState();
    state.selectAnonymizationTerm("Acme", "organization", "doc", "field-1");
    state.selectAnonymizationTerm("Acme", "organization", "doc", "field-1");

    expect(
      useInspectorAnonymizationStore.getState().anonymizationSelection,
    ).toEqual({
      canonical: "Acme",
      label: "organization",
      source: "doc",
      fieldId: "field-1",
      seq: 2,
    });
  });
});
