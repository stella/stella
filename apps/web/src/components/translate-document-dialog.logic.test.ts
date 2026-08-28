import { describe, expect, test } from "bun:test";

import {
  canStartDocumentTranslation,
  commentPolicyStateForSource,
  documentTranslationRunFailureKey,
  resolvedDocumentTranslationSource,
} from "./translate-document-dialog.logic";

describe("document translation start availability", () => {
  test("blocks a repeat submission while the created run is loading", () => {
    expect(
      canStartDocumentTranslation({
        canUseDeepL: true,
        isDeepL: true,
        isLoadingRun: true,
        isRunning: false,
        isStarting: false,
        hasCommentPolicy: false,
        hasPreparedAiSource: false,
        hasResolvedAiSource: false,
        requiresCommentPolicy: false,
        sameLanguage: false,
      }),
    ).toBeFalse();
  });

  test("requires an explicit comment policy when comments are found", () => {
    const options = {
      canUseDeepL: true,
      isDeepL: true,
      isLoadingRun: false,
      isRunning: false,
      isStarting: false,
      hasPreparedAiSource: true,
      hasResolvedAiSource: true,
      requiresCommentPolicy: true,
      sameLanguage: false,
    };
    expect(
      canStartDocumentTranslation({ ...options, hasCommentPolicy: false }),
    ).toBeFalse();
    expect(
      canStartDocumentTranslation({ ...options, hasCommentPolicy: true }),
    ).toBeTrue();
  });
});

describe("document translation failure copy", () => {
  test("names a persisted provider availability failure", () => {
    expect(documentTranslationRunFailureKey("provider_unavailable")).toBe(
      "translate.dialog.providerUnavailable",
    );
  });

  test("does not treat an unknown persisted code as provider copy", () => {
    expect(documentTranslationRunFailureKey("unknown-provider-code")).toBe(
      "translate.dialog.runFailed",
    );
  });
});

describe("document translation source resolution", () => {
  test("uses a version-bound automatic detection", () => {
    expect(
      resolvedDocumentTranslationSource({
        selection: { type: "automatic" },
        detection: {
          type: "detected",
          language: "EN-GB",
          confidence: "high",
        },
      }),
    ).toBe("EN-GB");
  });

  test.each([
    { type: "ambiguous", candidates: ["CS", "SK"] } as const,
    { type: "unknown" } as const,
  ])("requires a manual choice for $type detection", (detection) => {
    expect(
      resolvedDocumentTranslationSource({
        selection: { type: "automatic" },
        detection,
      }),
    ).toBeNull();
  });

  test("lets a manual choice override automatic detection", () => {
    expect(
      resolvedDocumentTranslationSource({
        selection: { type: "manual", language: "DE" },
        detection: {
          type: "detected",
          language: "EN-GB",
          confidence: "high",
        },
      }),
    ).toBe("DE");
  });
});

describe("document translation comment policy ownership", () => {
  const selectedForFirstDocument = {
    type: "required",
    entityId: "entity-a",
    fieldId: "field-a",
    policy: "translated",
  } as const;

  test("retains the selection only for the source that required it", () => {
    expect(
      commentPolicyStateForSource({
        state: selectedForFirstDocument,
        entityId: "entity-a",
        fieldId: "field-a",
      }),
    ).toBe(selectedForFirstDocument);
  });

  test.each([
    ["entity-b", "field-a"],
    ["entity-a", "field-b"],
    ["entity-b", "field-b"],
  ])("clears the selection for source %s/%s", (entityId, fieldId) => {
    expect(
      commentPolicyStateForSource({
        state: selectedForFirstDocument,
        entityId,
        fieldId,
      }),
    ).toEqual({ type: "unchecked" });
  });
});
