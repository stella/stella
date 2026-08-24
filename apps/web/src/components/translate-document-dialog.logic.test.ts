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
        sameLanguage: false,
      }),
    ).toBeFalse();
  });
});
