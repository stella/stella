import { describe, expect, test } from "bun:test";

import {
  dictationNoticeCopy,
  isDictationNoticeSnapshot,
} from "../src/mainview/dictation-notice";

describe("dictation notice", () => {
  test("an unasked microphone is asked for, on every platform", () => {
    for (const platform of ["mac", "windows", "other"] as const) {
      expect(
        dictationNoticeCopy({ fix: "request", kind: "microphone" }, platform),
      ).toEqual({ action: "allow", body: "allowBody", title: "title" });
    }
  });

  test("any other microphone opens the platform's privacy page", () => {
    const openSettings = { fix: "openSettings", kind: "microphone" } as const;
    expect(dictationNoticeCopy(openSettings, "mac")).toEqual({
      action: "openSettingsMac",
      body: "checkBodyMac",
      title: "title",
    });
    expect(dictationNoticeCopy(openSettings, "windows")).toEqual({
      action: "openSettingsPc",
      body: "checkBodyPc",
      title: "title",
    });
  });

  test("sound without speech opens the sound input settings", () => {
    const nothing = { fix: "openSound", kind: "nothingHeard" } as const;
    expect(dictationNoticeCopy(nothing, "mac")).toEqual({
      action: "openSoundMac",
      body: "nothingBody",
      title: "nothingTitle",
    });
    expect(dictationNoticeCopy(nothing, "windows")).toEqual({
      action: "openSoundPc",
      body: "nothingBody",
      title: "nothingTitle",
    });
  });

  test("without a settings page the notice still says what happened", () => {
    expect(
      dictationNoticeCopy({ fix: null, kind: "microphone" }, "other"),
    ).toEqual({ action: null, body: "checkBodyPc", title: "title" });
    expect(
      dictationNoticeCopy({ fix: null, kind: "nothingHeard" }, "other"),
    ).toEqual({ action: null, body: "nothingBody", title: "nothingTitle" });
  });

  test("a missing microphone leads to the microphone choice", () => {
    expect(
      dictationNoticeCopy(
        { fix: "chooseMicrophone", kind: "microphoneMissing" },
        "mac",
      ),
    ).toEqual({
      action: "chooseMicrophone",
      body: "missingBody",
      title: "missingTitle",
    });
  });

  test("a withdrawn model leads to the model choice", () => {
    for (const platform of ["mac", "windows", "other"] as const) {
      expect(
        dictationNoticeCopy(
          { fix: "chooseModel", kind: "modelWithdrawn" },
          platform,
        ),
      ).toEqual({
        action: "chooseModel",
        body: "modelBody",
        title: "modelTitle",
      });
    }
  });

  test("only the native side's states are accepted", () => {
    const valid = {
      fix: "request",
      inputDevice: null,
      kind: "microphone",
      missing: null,
    };
    expect(isDictationNoticeSnapshot(valid)).toBe(true);
    expect(
      isDictationNoticeSnapshot({
        fix: "openSound",
        inputDevice: "AirPods Pro 3",
        kind: "nothingHeard",
        missing: null,
      }),
    ).toBe(true);
    expect(isDictationNoticeSnapshot({ ...valid, fix: null })).toBe(true);
    expect(isDictationNoticeSnapshot({ ...valid, fix: "launch" })).toBe(false);
    expect(isDictationNoticeSnapshot({ ...valid, kind: "other" })).toBe(false);
    expect(isDictationNoticeSnapshot({ ...valid, inputDevice: 3 })).toBe(false);
    expect(isDictationNoticeSnapshot({ ...valid, missing: 1 })).toBe(false);
    expect(isDictationNoticeSnapshot({ fix: null })).toBe(false);
    expect(isDictationNoticeSnapshot(null)).toBe(false);
  });
});
