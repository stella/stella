import { describe, expect, test } from "bun:test";

import { DOCUMENT_TRANSLATION_RUN_ERROR_CODES } from "@stll/api-contract/document-translation";

import {
  canStartDocumentTranslation,
  commentPolicyStateForSource,
  documentTranslationRunFailureKey,
  openDocumentTranslationOutput,
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

  test.each([...DOCUMENT_TRANSLATION_RUN_ERROR_CODES])(
    "maps persisted $0 errors to intentional copy",
    (errorCode) => {
      expect(documentTranslationRunFailureKey(errorCode)).toBe(
        errorCode === "provider_unavailable"
          ? "translate.dialog.providerUnavailable"
          : "translate.dialog.runFailed",
      );
    },
  );
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

describe("document translation output handoff", () => {
  test("closes the dialog and prepares the destination before navigation", async () => {
    const events: string[] = [];

    await openDocumentTranslationOutput({
      closeDialog: () => {
        events.push("closed");
      },
      prepareDestination: async () => {
        events.push("prepared");
      },
      navigate: async () => {
        events.push("navigated");
      },
    });

    expect(events).toEqual(["prepared", "closed", "navigated"]);
  });

  test("does not navigate when the destination cannot be prepared", async () => {
    let navigated = false;
    let closed = false;

    expect(
      openDocumentTranslationOutput({
        closeDialog: () => {
          closed = true;
        },
        prepareDestination: async () => {
          throw new Error("destination unavailable");
        },
        navigate: async () => {
          navigated = true;
        },
      }),
    ).rejects.toThrow("destination unavailable");

    expect(navigated).toBeFalse();
    expect(closed).toBeFalse();
  });
});
