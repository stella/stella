import { describe, expect, test } from "bun:test";

import {
  DICTATION_SETUP_SCREENS,
  dictationSetupScreens,
  microphoneScreenPermissions,
  transcriptionChoices,
} from "../src/onboarding/dictation-setup-steps";
import type {
  DictationSetupScreen,
  DictationSetupState,
} from "../src/onboarding/dictation-setup-steps";
import { moveFrom, shownScreen } from "../src/onboarding/setup-screens";

const DEFAULTS = {
  cleanup: true,
  cloudAvailable: false,
  destination: "local",
} as const satisfies DictationSetupState;

describe("the screens of the Dictation step", () => {
  test("come in the order microphone, transcription, app, context, words", () => {
    expect([...DICTATION_SETUP_SCREENS]).toEqual([
      "microphone",
      "transcription",
      "app",
      "context",
      "words",
    ]);
    expect(dictationSetupScreens(DEFAULTS)).toEqual([
      ...DICTATION_SETUP_SCREENS,
    ]);
  });

  test("leave out more context while cleanup is off: only cleanup reads it", () => {
    expect(
      dictationSetupScreens({ ...DEFAULTS, cleanup: false }),
    ).not.toContain("context");
  });

  test("leave out custom words with neither cleanup nor stella AI to use them", () => {
    expect(dictationSetupScreens({ ...DEFAULTS, cleanup: false })).toEqual([
      "microphone",
      "transcription",
      "app",
    ]);
    expect(
      dictationSetupScreens({
        cleanup: false,
        cloudAvailable: true,
        destination: "cloud",
      }),
    ).toEqual(["microphone", "transcription", "app", "words"]);
  });

  test("always keep the microphone, transcription and app screens", () => {
    for (const cleanup of [true, false]) {
      for (const destination of ["local", "cloud"] as const) {
        expect(
          dictationSetupScreens({ cleanup, cloudAvailable: true, destination }),
        ).toEqual(
          expect.arrayContaining(["microphone", "transcription", "app"]),
        );
      }
    }
  });
});

describe("the transcription choice", () => {
  test("offers stella AI only to an account that has it", () => {
    expect(transcriptionChoices(DEFAULTS)).toEqual(["local"]);
    expect(transcriptionChoices({ ...DEFAULTS, cloudAvailable: true })).toEqual(
      ["local", "cloud"],
    );
  });

  test("still shows stella AI to a speaker already using it, to switch back", () => {
    expect(
      transcriptionChoices({ cloudAvailable: false, destination: "cloud" }),
    ).toEqual(["local", "cloud"]);
  });
});

describe("the microphone screen's permissions", () => {
  const BOTH = ["microphone", "accessibility"] as const;

  test("ask for the microphone, then Accessibility, on a Mac", () => {
    expect(microphoneScreenPermissions(BOTH, "mac")).toEqual([
      "microphone",
      "accessibility",
    ]);
    expect(
      microphoneScreenPermissions(["accessibility", "microphone"], "mac"),
    ).toEqual(["microphone", "accessibility"]);
  });

  test("never ask for Accessibility off a Mac", () => {
    expect(microphoneScreenPermissions(BOTH, "windows")).toEqual([
      "microphone",
    ]);
    expect(microphoneScreenPermissions(BOTH, "other")).toEqual(["microphone"]);
  });

  test("ask for nothing the native side does not list", () => {
    expect(microphoneScreenPermissions([], "mac")).toEqual([]);
    expect(microphoneScreenPermissions(["notifications"], "mac")).toEqual([]);
  });
});

const move = (
  screens: readonly DictationSetupScreen[],
  screen: DictationSetupScreen,
  direction: "back" | "continue",
) => moveFrom({ direction, order: DICTATION_SETUP_SCREENS, screen, screens });

const shown = (
  screens: readonly DictationSetupScreen[],
  screen: DictationSetupScreen,
) => shownScreen({ order: DICTATION_SETUP_SCREENS, screen, screens });

describe("moving between the screens", () => {
  const all = dictationSetupScreens(DEFAULTS);

  test("Continue walks the screens in order, then leaves the step", () => {
    const visited = [];
    let screen = all[0];
    for (;;) {
      if (screen === undefined) {
        break;
      }
      visited.push(screen);
      const next = move(all, screen, "continue");
      if (next.type !== "screen") {
        expect(next.type).toBe("leaveForward");
        break;
      }
      screen = next.screen;
    }
    expect(visited).toEqual(all);
  });

  test("Back from the first screen leaves for the step before", () => {
    expect(move(all, "microphone", "back")).toEqual({ type: "leaveBack" });
    expect(move(all, "transcription", "back")).toEqual({
      screen: "microphone",
      type: "screen",
    });
  });

  test("Continue skips a screen that does not apply", () => {
    const withoutCleanup = dictationSetupScreens({
      cleanup: false,
      cloudAvailable: true,
      destination: "cloud",
    });
    expect(move(withoutCleanup, "app", "continue")).toEqual({
      screen: "words",
      type: "screen",
    });
    expect(move(withoutCleanup, "words", "back")).toEqual({
      screen: "app",
      type: "screen",
    });
  });

  test("a screen that stops applying while shown hands over to the next", () => {
    const withoutContext = dictationSetupScreens({
      ...DEFAULTS,
      cleanup: false,
      destination: "cloud",
    });
    expect(shown(withoutContext, "context")).toBe("words");
    expect(move(withoutContext, "context", "continue")).toEqual({
      screen: "words",
      type: "screen",
    });
    expect(move(withoutContext, "context", "back")).toEqual({
      screen: "app",
      type: "screen",
    });
    // With nothing after it, the last screen that still applies is shown,
    // and Continue leaves the step.
    const fewest = dictationSetupScreens({ ...DEFAULTS, cleanup: false });
    expect(shown(fewest, "words")).toBe("app");
    expect(move(fewest, "words", "continue")).toEqual({
      type: "leaveForward",
    });
    expect(move(fewest, "words", "back")).toEqual({
      screen: "app",
      type: "screen",
    });
  });
});
