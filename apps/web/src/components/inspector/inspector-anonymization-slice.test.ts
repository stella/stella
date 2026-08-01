import { beforeEach, describe, expect, test } from "bun:test";

import { useInspectorAnonymizationStore } from "@/components/inspector/inspector-anonymization-store";

beforeEach(() => {
  useInspectorAnonymizationStore.setState({
    anonymizationActiveMountCount: 0,
    documentTextSelectionByFieldId: {},
    anonymizationMatchesByFieldId: {},
    anonymizationPipelineStartedFieldIds: new Set(),
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

  test("pipeline membership is idempotent", () => {
    const state = useInspectorAnonymizationStore.getState();
    state.markAnonymizationPipelineStarted("field-1");
    state.markAnonymizationPipelineStarted("field-1");

    expect([
      ...useInspectorAnonymizationStore.getState()
        .anonymizationPipelineStartedFieldIds,
    ]).toEqual(["field-1"]);

    state.markAnonymizationPipelineRan("field-1");
    state.markAnonymizationPipelineRan("field-1");
    expect(
      useInspectorAnonymizationStore.getState()
        .anonymizationPipelineStartedFieldIds.size,
    ).toBe(0);
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
