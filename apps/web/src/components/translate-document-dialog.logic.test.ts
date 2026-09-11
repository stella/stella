import { describe, expect, test } from "bun:test";

import { DOCUMENT_TRANSLATION_RUN_ERROR_CODES } from "@stll/api-contract/document-translation";

import { DOCUMENT_TRANSLATION_TARGET_CODES } from "./document-language-picker.logic";
import {
  activeTranslationChoice,
  canStartDocumentTranslation,
  canTranslateDocument,
  commentPolicyStateForSource,
  DEFAULT_TRANSLATION_CHOICE,
  defaultDocumentTranslationTarget,
  documentTranslationRunFailureKey,
  openDocumentTranslationOutput,
  parseLastTranslationTarget,
} from "./translate-document-dialog.logic";

describe("document translation availability", () => {
  test("offers stella AI for DOCX without DeepL", () => {
    expect(
      canTranslateDocument({ canUseDeepL: false, isDocx: true }),
    ).toBeTrue();
  });

  test("offers DeepL for a PDF when configured", () => {
    expect(
      canTranslateDocument({ canUseDeepL: true, isDocx: false }),
    ).toBeTrue();
  });

  test("offers nothing for a PDF without DeepL", () => {
    expect(
      canTranslateDocument({ canUseDeepL: false, isDocx: false }),
    ).toBeFalse();
  });
});

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
        hasPreparedAiVersion: false,
        requiresCommentPolicy: false,
      }),
    ).toBeFalse();
  });

  test("waits for the pinned version before starting stella AI", () => {
    const options = {
      canUseDeepL: false,
      isDeepL: false,
      isLoadingRun: false,
      isRunning: false,
      isStarting: false,
      hasCommentPolicy: false,
      requiresCommentPolicy: false,
    };
    expect(
      canStartDocumentTranslation({
        ...options,
        hasPreparedAiVersion: false,
      }),
    ).toBeFalse();
    expect(
      canStartDocumentTranslation({
        ...options,
        hasPreparedAiVersion: true,
      }),
    ).toBeTrue();
  });

  test("requires an explicit comment policy when comments are found", () => {
    const options = {
      canUseDeepL: true,
      isDeepL: true,
      isLoadingRun: false,
      isRunning: false,
      isStarting: false,
      hasPreparedAiVersion: true,
      requiresCommentPolicy: true,
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

    const rejection = await openDocumentTranslationOutput({
      closeDialog: () => {
        closed = true;
      },
      prepareDestination: async () => {
        throw new Error("destination unavailable");
      },
      navigate: async () => {
        navigated = true;
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({ message: "destination unavailable" });
    expect(navigated).toBeFalse();
    expect(closed).toBeFalse();
  });
});

describe("default translation target", () => {
  const options = {
    lastUsedTarget: null,
    supportedTargets: DOCUMENT_TRANSLATION_TARGET_CODES,
    uiLocale: "cs",
  } as const;

  test("falls back to this browser's last choice", () => {
    expect(
      defaultDocumentTranslationTarget({ ...options, lastUsedTarget: "PT-BR" }),
    ).toBe("PT-BR");
  });

  test("falls back to the UI locale", () => {
    expect(
      defaultDocumentTranslationTarget({ ...options, uiLocale: "pl" }),
    ).toBe("PL");
  });

  test("falls back to the first offered language", () => {
    expect(
      defaultDocumentTranslationTarget({
        ...options,
        supportedTargets: ["AR", "DE"],
        uiLocale: "ja",
      }),
    ).toBe("AR");
  });

  test("keeps an explicit same-language target for provider-side handling", () => {
    expect(
      defaultDocumentTranslationTarget({ ...options, lastUsedTarget: "CS" }),
    ).toBe("CS");
  });
});

describe("active translation choice", () => {
  test("opens on stella AI, never on DeepL", () => {
    expect(
      activeTranslationChoice({
        selected: DEFAULT_TRANSLATION_CHOICE,
        canUseDeepL: true,
        isDocx: true,
      }),
    ).toBe("translated:ai");
  });

  test("drops a DeepL selection once the key is gone", () => {
    expect(
      activeTranslationChoice({
        selected: "translated:deepl",
        canUseDeepL: false,
        isDocx: true,
      }),
    ).toBe("translated:ai");
  });

  test("leaves DeepL selected while it is configured", () => {
    expect(
      activeTranslationChoice({
        selected: "translated:deepl",
        canUseDeepL: true,
        isDocx: true,
      }),
    ).toBe("translated:deepl");
  });

  test("falls to DeepL for a file stella AI cannot open", () => {
    expect(
      activeTranslationChoice({
        selected: "bilingual:ai",
        canUseDeepL: true,
        isDocx: false,
      }),
    ).toBe("translated:deepl");
  });

  test("keeps the AI selection when nothing else is available either", () => {
    expect(
      activeTranslationChoice({
        selected: "translated:ai",
        canUseDeepL: false,
        isDocx: false,
      }),
    ).toBe("translated:ai");
  });
});

describe("remembered translation target", () => {
  test("keeps a code the catalog still names", () => {
    expect(parseLastTranslationTarget("PT-BR")).toBe("PT-BR");
  });

  test("forgets an absent or retired code", () => {
    expect(parseLastTranslationTarget(null)).toBeNull();
    expect(parseLastTranslationTarget("KL")).toBeNull();
  });
});
