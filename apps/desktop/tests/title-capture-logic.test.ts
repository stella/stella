import { describe, expect, test } from "bun:test";

import { ACTIVITY_DETAILS_ACCESS } from "../src/activity/activity-types";
import {
  explainedBrowsers,
  missingTitlesReason,
  titleGate,
  titlesNeedAccessibility,
} from "../src/activity/title-capture-logic";
import type { TitleCaptureSettings } from "../src/activity/title-capture-logic";

const CHROME = { identifier: "com.google.chrome", name: "Google Chrome" };
const SAFARI = { identifier: "com.apple.safari", name: "Safari" };
const WORD = "com.microsoft.Word";

/** Details on, Accessibility granted; Chrome seen today but never allowed,
 * Safari allowed. */
const SETTINGS = {
  captureDetails: true,
  detailsAccess: "ready",
  appNameOnlyApps: [],
  browserApps: [CHROME, SAFARI],
  browserTitleApps: [SAFARI],
} satisfies TitleCaptureSettings;

const NONE = new Set<string>();

describe("which gate keeps an app's window titles out", () => {
  test("titles are recorded once every gate is open", () => {
    expect(titleGate(SETTINGS, WORD)).toEqual({ type: "open" });
    expect(titleGate(SETTINGS, SAFARI.identifier)).toEqual({ type: "open" });
  });

  test("a browser outside its own consent list is withheld, whatever the casing the segment kept", () => {
    expect(titleGate(SETTINGS, "com.google.Chrome")).toEqual({
      browser: CHROME,
      type: "browserOff",
    });
  });

  test("details off closes every app before any other gate", () => {
    const off = {
      ...SETTINGS,
      captureDetails: false,
      detailsAccess: "disabled",
      appNameOnlyApps: [CHROME],
    } satisfies TitleCaptureSettings;
    for (const identifier of [WORD, CHROME.identifier, SAFARI.identifier]) {
      expect(titleGate(off, identifier)).toEqual({ type: "detailsOff" });
    }
    expect(titlesNeedAccessibility(off)).toBe(false);
  });

  test("an app set to its name only is the user's choice, not a missing permission", () => {
    const nameOnly = {
      ...SETTINGS,
      detailsAccess: "accessibilityRequired",
      appNameOnlyApps: [CHROME],
    } satisfies TitleCaptureSettings;
    expect(titleGate(nameOnly, CHROME.identifier)).toEqual({
      type: "appNameOnly",
    });
    expect(explainedBrowsers(nameOnly, [CHROME.identifier], NONE)).toEqual([]);
  });

  test("missing Accessibility closes every app ahead of a browser's own consent", () => {
    const untrusted = {
      ...SETTINGS,
      detailsAccess: "accessibilityRequired",
    } satisfies TitleCaptureSettings;
    for (const identifier of [WORD, CHROME.identifier, SAFARI.identifier]) {
      expect(titleGate(untrusted, identifier)).toEqual({
        type: "accessibilityRequired",
      });
    }
    expect(titlesNeedAccessibility(untrusted)).toBe(true);
    // Turning Chrome on now would record nothing, so it is not offered.
    expect(explainedBrowsers(untrusted, [CHROME.identifier], NONE)).toEqual([]);
  });

  test("the strip shows only for the access state that one setting fixes", () => {
    const shown = ACTIVITY_DETAILS_ACCESS.filter((detailsAccess) =>
      titlesNeedAccessibility({ ...SETTINGS, detailsAccess }),
    );
    expect(shown).toEqual(["accessibilityRequired"]);
  });
});

describe("the browsers a stretch of time explains", () => {
  test("each withheld browser once, in first-seen order, never a titled one or another app", () => {
    const opera = { identifier: "com.operasoftware.opera", name: "Opera" };
    const settings = {
      ...SETTINGS,
      browserApps: [CHROME, SAFARI, opera],
    } satisfies TitleCaptureSettings;
    expect(
      explainedBrowsers(
        settings,
        [
          opera.identifier,
          WORD,
          "com.google.Chrome",
          SAFARI.identifier,
          CHROME.identifier,
        ],
        NONE,
      ),
    ).toEqual([
      { browser: opera, status: "withheld" },
      { browser: CHROME, status: "withheld" },
    ]);
  });

  test("a browser turned on from here keeps its confirmation once it records", () => {
    const recording = {
      ...SETTINGS,
      browserTitleApps: [SAFARI, CHROME],
    } satisfies TitleCaptureSettings;
    const turnedOn = new Set([CHROME.identifier]);
    expect(explainedBrowsers(recording, [CHROME.identifier], turnedOn)).toEqual(
      [{ browser: CHROME, status: "turnedOn" }],
    );
    // Not before the snapshot says it records, and not after it stops.
    expect(explainedBrowsers(SETTINGS, [CHROME.identifier], turnedOn)).toEqual([
      { browser: CHROME, status: "withheld" },
    ]);
    expect(
      explainedBrowsers(
        { ...recording, detailsAccess: "accessibilityRequired" },
        [CHROME.identifier],
        turnedOn,
      ),
    ).toEqual([]);
  });
});

describe("why a suggestion recorded no titles", () => {
  test("Accessibility wins over a withheld browser", () => {
    expect(
      missingTitlesReason(
        { ...SETTINGS, detailsAccess: "accessibilityRequired" },
        [CHROME.identifier, WORD],
        NONE,
      ),
    ).toEqual({ type: "accessibilityRequired" });
  });

  test("a withheld browser is named with its action", () => {
    expect(
      missingTitlesReason(SETTINGS, [WORD, CHROME.identifier], NONE),
    ).toEqual({
      browsers: [{ browser: CHROME, status: "withheld" }],
      type: "browsers",
    });
  });

  test("a choice the user made, or a platform without access, explains nothing", () => {
    expect(
      missingTitlesReason(
        { ...SETTINGS, captureDetails: false, detailsAccess: "disabled" },
        [CHROME.identifier],
        NONE,
      ),
    ).toEqual({ type: "none" });
    expect(
      missingTitlesReason(
        { ...SETTINGS, detailsAccess: "unavailable" },
        [CHROME.identifier, WORD],
        NONE,
      ),
    ).toEqual({ type: "none" });
    expect(missingTitlesReason(SETTINGS, [WORD], NONE)).toEqual({
      type: "none",
    });
  });
});
