import { describe, expect, test } from "bun:test";

import { canStartDocumentTranslation } from "./translate-document-dialog.logic";

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
