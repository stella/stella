import { describe, expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";

import {
  mobileMessage,
  mobileMessageWithEmail,
  mobileMessageLocales,
  mobileMessages,
} from "./messages";

describe("mobile messages", () => {
  test("covers every canonical UI locale without runtime fallback", () => {
    expect(mobileMessageLocales).toEqual(UI_LOCALES);
    expect(Object.keys(mobileMessages).sort()).toEqual([...UI_LOCALES].sort());

    for (const locale of UI_LOCALES) {
      expect(mobileMessage("signIn", locale).trim().length).toBeGreaterThan(0);
      expect(Object.keys(mobileMessages[locale]).sort()).toEqual(
        Object.keys(mobileMessages.en).sort(),
      );
    }
  });

  test("formats rich-text catalog placeholders for native text", () => {
    expect(
      mobileMessageWithEmail("codeSentTo", "person@example.com", "en"),
    ).toBe("We sent a code to person@example.com");
  });
});
