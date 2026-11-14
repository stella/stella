import { describe, expect, test } from "bun:test";

import type {
  ActivityAppExclusion,
  ActivityDaySnapshot,
} from "../src/activity/activity-types";
import {
  CAPTURE_MODES,
  captureModeApps,
  captureModeCommands,
  effectiveCaptureMode,
  savedCaptureMode,
  undecidedBrowser,
} from "../src/activity/capture-modes";
import type {
  CaptureLists,
  CaptureMode,
  CaptureModeCommand,
} from "../src/activity/capture-modes";

const WORD = { identifier: "com.microsoft.word", name: "Microsoft Word" };
const TERMINAL = { identifier: "com.apple.terminal", name: "Terminal" };
const MUSIC = { identifier: "com.apple.music", name: "Music" };
const CHROME = { identifier: "com.google.chrome", name: "Google Chrome" };
const SAFARI = { identifier: "com.apple.safari", name: "Safari" };

const LISTS: CaptureLists = {
  captureDetails: true,
  appNameOnlyApps: [TERMINAL],
  browserApps: [CHROME, SAFARI],
  browserTitleApps: [SAFARI],
  excludedApps: [MUSIC],
};

/** The lists after the native side applies `commands`, as it stores them. */
const apply = (
  lists: CaptureLists,
  commands: CaptureModeCommand[],
): CaptureLists => {
  const next = {
    ...lists,
    appNameOnlyApps: [...lists.appNameOnlyApps],
    browserTitleApps: [...lists.browserTitleApps],
    excludedApps: [...lists.excludedApps],
  };
  for (const { command, args } of commands) {
    const without = (apps: ActivityAppExclusion[]) =>
      apps.filter((app) => app.identifier !== args.identifier);
    switch (command) {
      case "activity_remove_app_exclusion":
        next.excludedApps = without(next.excludedApps);
        break;
      case "activity_set_app_detail_capture":
        next.appNameOnlyApps = without(next.appNameOnlyApps);
        if (args.mode === "appNameOnly") {
          next.appNameOnlyApps.push({
            identifier: args.identifier,
            name: args.name,
          });
        }
        break;
      case "activity_set_browser_title_capture":
        next.browserTitleApps = without(next.browserTitleApps);
        if (args.enabled) {
          next.browserTitleApps.push({
            identifier: args.identifier,
            name: args.name,
          });
        }
        break;
      default:
        command satisfies never;
        throw new TypeError("Unknown command");
    }
  }
  return next;
};

/** Every combination of list membership one app can have. */
const membershipCases = (app: ActivityAppExclusion, browser: boolean) =>
  [false, true].flatMap((excluded) =>
    [false, true].flatMap((nameOnly) =>
      (browser ? [false, true] : [false]).map((titles): CaptureLists => ({
        captureDetails: true,
        appNameOnlyApps: nameOnly ? [app] : [],
        browserApps: browser ? [app] : [],
        browserTitleApps: titles ? [app] : [],
        excludedApps: excluded ? [app] : [],
      })),
    ),
  );

describe("the mode Settings shows for an app", () => {
  test("reads each app's saved lists in words", () => {
    expect(savedCaptureMode(LISTS, WORD.identifier)).toBe("titles");
    expect(savedCaptureMode(LISTS, TERMINAL.identifier)).toBe("appOnly");
    expect(savedCaptureMode(LISTS, MUSIC.identifier)).toBe("nothing");
    expect(savedCaptureMode(LISTS, SAFARI.identifier)).toBe("titles");
  });

  test("a browser records titles only once it was chosen for them", () => {
    expect(savedCaptureMode(LISTS, CHROME.identifier)).toBe("appOnly");
    expect(
      savedCaptureMode(
        { ...LISTS, appNameOnlyApps: [SAFARI] },
        SAFARI.identifier,
      ),
    ).toBe("appOnly");
  });

  test("an exclusion wins over every other list", () => {
    for (const lists of membershipCases(CHROME, true)) {
      if (lists.excludedApps.length > 0) {
        expect(savedCaptureMode(lists, CHROME.identifier)).toBe("nothing");
      }
    }
  });

  test("identifiers compare as the native side stores them", () => {
    expect(savedCaptureMode(LISTS, " COM.Apple.Music ")).toBe("nothing");
    expect(savedCaptureMode(LISTS, "com.Google.Chrome")).toBe("appOnly");
  });

  test("with details off no app shows titles, and exclusions still show", () => {
    const off = { ...LISTS, captureDetails: false };
    expect(effectiveCaptureMode(off, WORD.identifier)).toBe("appOnly");
    expect(effectiveCaptureMode(off, SAFARI.identifier)).toBe("appOnly");
    expect(effectiveCaptureMode(off, MUSIC.identifier)).toBe("nothing");
    expect(effectiveCaptureMode(LISTS, WORD.identifier)).toBe("titles");
  });
});

describe("changing an app's mode", () => {
  const targets = CAPTURE_MODES.filter(
    (mode): mode is Exclude<CaptureMode, "nothing"> => mode !== "nothing",
  );

  for (const [label, app, browser] of [
    ["an app", WORD, false],
    ["a browser", CHROME, true],
  ] as const) {
    test(`reaches every target from every saved state for ${label}`, () => {
      for (const lists of membershipCases(app, browser)) {
        for (const target of targets) {
          const commands = captureModeCommands(lists, app, target);
          expect(savedCaptureMode(apply(lists, commands), app.identifier)).toBe(
            target,
          );
        }
      }
    });

    test(`never widens what ${label} records when it is already there`, () => {
      for (const lists of membershipCases(app, browser)) {
        const mode = savedCaptureMode(lists, app.identifier);
        if (mode === "nothing") {
          continue;
        }
        const widening = captureModeCommands(lists, app, mode).filter(
          ({ command, args }) =>
            command === "activity_remove_app_exclusion" ||
            ("enabled" in args && args.enabled) ||
            ("mode" in args && args.mode === "includeDetails"),
        );
        expect(widening).toEqual([]);
      }
    });

    test(`lifts an exclusion last for ${label}`, () => {
      for (const lists of membershipCases(app, browser)) {
        if (lists.excludedApps.length === 0) {
          continue;
        }
        for (const target of targets) {
          const commands = captureModeCommands(lists, app, target);
          expect(commands.at(-1)?.command).toBe(
            "activity_remove_app_exclusion",
          );
        }
      }
    });
  }

  test("a browser set to its name only is kept as decided", () => {
    expect(captureModeCommands(LISTS, CHROME, "appOnly")).toEqual([
      {
        command: "activity_set_app_detail_capture",
        args: { ...CHROME, mode: "appNameOnly" },
      },
    ]);
  });

  test("a browser stops recording titles before it is set to its name", () => {
    expect(captureModeCommands(LISTS, SAFARI, "appOnly")).toEqual([
      {
        command: "activity_set_browser_title_capture",
        args: { ...SAFARI, enabled: false },
      },
      {
        command: "activity_set_app_detail_capture",
        args: { ...SAFARI, mode: "appNameOnly" },
      },
    ]);
  });

  test("an app other than a browser never sends the browser command", () => {
    for (const lists of membershipCases(WORD, false)) {
      for (const target of targets) {
        expect(
          captureModeCommands(lists, WORD, target).map(
            ({ command }) => command,
          ),
        ).not.toContain("activity_set_browser_title_capture");
      }
    }
  });
});

const segment = (app: ActivityAppExclusion, hour: string) => ({
  appIdentifier: app.identifier,
  appName: app.name,
  start: `2026-11-10T${hour}:00:00Z`,
  end: `2026-11-10T${hour}:30:00Z`,
});

const DAY = {
  captureDetails: true,
  appNameOnlyApps: [],
  browserApps: [CHROME, SAFARI],
  browserTitleApps: [],
  excludedApps: [],
  segments: [segment(WORD, "08"), segment(SAFARI, "09"), segment(CHROME, "10")],
} satisfies Parameters<typeof undecidedBrowser>[0];

describe("which browser the Activity window asks about", () => {
  test("the first undecided browser in the day's activity, only one", () => {
    expect(undecidedBrowser(DAY, new Set())).toEqual(SAFARI);
  });

  test("never with details off", () => {
    expect(undecidedBrowser({ ...DAY, captureDetails: false }, new Set())).toBe(
      null,
    );
  });

  test("a browser chosen for titles, set to its name, or excluded is decided", () => {
    for (const decided of [
      { browserTitleApps: [SAFARI] },
      { appNameOnlyApps: [SAFARI] },
      { excludedApps: [SAFARI] },
    ] satisfies Partial<ActivityDaySnapshot>[]) {
      expect(undecidedBrowser({ ...DAY, ...decided }, new Set())).toEqual(
        CHROME,
      );
    }
    expect(
      undecidedBrowser(
        {
          ...DAY,
          browserTitleApps: [SAFARI],
          appNameOnlyApps: [CHROME],
        },
        new Set(),
      ),
    ).toBe(null);
  });

  test("a question put off moves on to the next browser", () => {
    expect(undecidedBrowser(DAY, new Set([SAFARI.identifier]))).toEqual(CHROME);
    expect(
      undecidedBrowser(DAY, new Set([SAFARI.identifier, CHROME.identifier])),
    ).toBe(null);
  });

  test("a browser chosen earlier but absent from the day is not asked about", () => {
    expect(
      undecidedBrowser({ ...DAY, segments: [segment(WORD, "08")] }, new Set()),
    ).toBe(null);
  });

  test("answering with either choice leaves the browser decided", () => {
    const lists = { ...DAY, browserApps: [SAFARI], segments: DAY.segments };
    for (const choice of ["titles", "appOnly"] as const) {
      const answered = {
        ...DAY,
        ...apply(lists, captureModeCommands(lists, SAFARI, choice)),
        browserApps: [CHROME, SAFARI],
      };
      expect(undecidedBrowser(answered, new Set())).toEqual(CHROME);
    }
  });
});

describe("the apps Settings lists", () => {
  test("the day's apps in order, then saved choices by name, each once", () => {
    expect(
      captureModeApps([WORD, CHROME, TERMINAL], LISTS, "en").map(
        ({ name }) => name,
      ),
    ).toEqual([
      "Microsoft Word",
      "Google Chrome",
      "Terminal",
      "Music",
      "Safari",
    ]);
  });

  test("an app changed in the view stays listed without a saved choice", () => {
    const kept = { identifier: "com.example.notes", name: "Notes" };
    expect(captureModeApps([], LISTS, "en", [kept])).toContainEqual(kept);
  });
});
