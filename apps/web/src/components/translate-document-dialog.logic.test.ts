import { describe, expect, test } from "bun:test";

import {
  canStartDocumentTranslation,
  commentPolicyStateForSource,
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
