import { describe, expect, test } from "bun:test";

import {
  dictationNoticeCopy,
  isDictationNoticeSnapshot,
} from "../src/mainview/dictation-notice";

describe("dictation notice", () => {
  test("an unasked microphone is asked for, on every platform", () => {
    for (const platform of ["mac", "windows", "other"] as const) {
      expect(dictationNoticeCopy("request", platform)).toEqual({
        action: "allow",
        body: "allowBody",
      });
    }
  });

  test("any other microphone opens the platform's settings page", () => {
    expect(dictationNoticeCopy("openSettings", "mac")).toEqual({
      action: "openSettingsMac",
      body: "checkBodyMac",
    });
    expect(dictationNoticeCopy("openSettings", "windows")).toEqual({
      action: "openSettingsPc",
      body: "checkBodyPc",
    });
  });

  test("without a settings page the notice still says what happened", () => {
    expect(dictationNoticeCopy(null, "other")).toEqual({
      action: null,
      body: "checkBodyPc",
    });
  });

  test("only the native side's actions are accepted", () => {
    expect(isDictationNoticeSnapshot({ fix: "request" })).toBe(true);
    expect(isDictationNoticeSnapshot({ fix: "openSettings" })).toBe(true);
    expect(isDictationNoticeSnapshot({ fix: null })).toBe(true);
    expect(isDictationNoticeSnapshot({ fix: "launch" })).toBe(false);
    expect(isDictationNoticeSnapshot({})).toBe(false);
    expect(isDictationNoticeSnapshot(null)).toBe(false);
  });
});
