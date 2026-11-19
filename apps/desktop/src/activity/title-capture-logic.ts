import { panic } from "better-result";

import type {
  ActivityAppExclusion,
  ActivityCaptureSettings,
} from "./activity-types";

/** The capture settings that decide whether an app's window titles are
 * recorded. */
export type TitleCaptureSettings = Pick<
  ActivityCaptureSettings,
  | "appNameOnlyApps"
  | "browserApps"
  | "browserTitleApps"
  | "captureDetails"
  | "detailsAccess"
>;

/**
 * The first gate that keeps an app's window titles from being recorded from
 * now on, in the order the native recorder checks them: the details choice,
 * the app's own app-name-only choice, platform access, then a browser's own
 * opt-in. `open` means titles are recorded.
 */
export type TitleGate =
  | { type: "open" }
  | { type: "detailsOff" }
  | { type: "appNameOnly" }
  | { type: "accessibilityRequired" }
  | { type: "unavailable" }
  | { browser: ActivityAppExclusion; type: "browserOff" };

/** Stored app lists hold the trimmed, lowercased identifier the native side
 * compares against. */
const findApp = (apps: readonly ActivityAppExclusion[], identifier: string) => {
  const comparable = identifier.trim().toLowerCase();
  return apps.find((app) => app.identifier === comparable);
};

/** The gates every app shares: the details choice, then platform access. */
const sharedTitleGate = ({
  captureDetails,
  detailsAccess,
}: TitleCaptureSettings): TitleGate => {
  if (!captureDetails) {
    return { type: "detailsOff" };
  }
  switch (detailsAccess) {
    // Access reads as disabled only while details are off.
    case "disabled":
      return { type: "detailsOff" };
    case "accessibilityRequired":
      return { type: "accessibilityRequired" };
    case "unavailable":
      return { type: "unavailable" };
    case "ready":
      return { type: "open" };
    default:
      detailsAccess satisfies never;
      return panic("Unhandled activity details access");
  }
};

export const titleGate = (
  settings: TitleCaptureSettings,
  identifier: string,
): TitleGate => {
  if (
    settings.captureDetails &&
    findApp(settings.appNameOnlyApps, identifier) !== undefined
  ) {
    return { type: "appNameOnly" };
  }
  const shared = sharedTitleGate(settings);
  if (shared.type !== "open") {
    return shared;
  }
  const browser = findApp(settings.browserApps, identifier);
  if (
    browser !== undefined &&
    findApp(settings.browserTitleApps, identifier) === undefined
  ) {
    return { browser, type: "browserOff" };
  }
  return shared;
};

/** Whether Accessibility access is what keeps every window title out. */
export const titlesNeedAccessibility = (settings: TitleCaptureSettings) =>
  sharedTitleGate(settings).type === "accessibilityRequired";

/** A browser a stretch of time explains: its titles are `withheld` by its
 * own opt-in alone, or were `turnedOn` from this window and are recorded
 * now, so the confirmation stays where the action was. */
export type ExplainedBrowser = {
  browser: ActivityAppExclusion;
  status: "turnedOn" | "withheld";
};

/** The browsers among `identifiers` to explain, once each, in first-seen
 * order. `turnedOn` holds the identifiers of browsers turned on from this
 * window. */
export const explainedBrowsers = (
  settings: TitleCaptureSettings,
  identifiers: Iterable<string>,
  turnedOn: ReadonlySet<string>,
): ExplainedBrowser[] => {
  const browsers = new Map<string, ExplainedBrowser>();
  for (const identifier of identifiers) {
    const gate = titleGate(settings, identifier);
    const browser = findApp(settings.browserApps, identifier);
    if (browser === undefined || browsers.has(browser.identifier)) {
      continue;
    }
    if (gate.type === "browserOff") {
      browsers.set(browser.identifier, { browser, status: "withheld" });
    } else if (gate.type === "open" && turnedOn.has(browser.identifier)) {
      browsers.set(browser.identifier, { browser, status: "turnedOn" });
    }
  }
  return [...browsers.values()];
};

/** Why a stretch of time has no titles, when one action would change that:
 * Accessibility first, since no app records titles without it. A closed
 * gate the user chose (details off, app name only) or one no action opens
 * (unavailable) is no reason to show. */
export type MissingTitlesReason =
  | { type: "none" }
  | { type: "accessibilityRequired" }
  | { browsers: ExplainedBrowser[]; type: "browsers" };

export const missingTitlesReason = (
  settings: TitleCaptureSettings,
  identifiers: readonly string[],
  turnedOn: ReadonlySet<string>,
): MissingTitlesReason => {
  if (
    identifiers.some(
      (identifier) =>
        titleGate(settings, identifier).type === "accessibilityRequired",
    )
  ) {
    return { type: "accessibilityRequired" };
  }
  const browsers = explainedBrowsers(settings, identifiers, turnedOn);
  return browsers.length === 0
    ? { type: "none" }
    : { browsers, type: "browsers" };
};
