import type {
  ActivityAppExclusion,
  ActivityCaptureSettings,
  ActivityDaySnapshot,
} from "./activity-types";

/**
 * What the recorder keeps for one app, in the words Settings shows:
 * window titles and documents, the app name only, or nothing at all.
 */
export const CAPTURE_MODES = ["titles", "appOnly", "nothing"] as const;

export type CaptureMode = (typeof CAPTURE_MODES)[number];

/** The lists the native recorder reads one app's mode from. */
export type CaptureLists = Pick<
  ActivityCaptureSettings,
  "appNameOnlyApps" | "browserApps" | "browserTitleApps" | "captureDetails"
> & { excludedApps: ActivityAppExclusion[] };

/** The comparable form of an app identifier, as the native side keeps it. */
const appKey = (identifier: string) => identifier.trim().toLowerCase();

const isListed = (
  apps: readonly ActivityAppExclusion[],
  identifier: string,
): boolean => apps.some((app) => appKey(app.identifier) === appKey(identifier));

/**
 * The mode the saved lists give one app, whether or not details are on:
 * an excluded app records nothing; an app set to its name records only
 * that; a browser records titles only once it was chosen for them.
 */
export const savedCaptureMode = (
  lists: CaptureLists,
  identifier: string,
): CaptureMode => {
  if (isListed(lists.excludedApps, identifier)) {
    return "nothing";
  }
  if (isListed(lists.appNameOnlyApps, identifier)) {
    return "appOnly";
  }
  if (
    isListed(lists.browserApps, identifier) &&
    !isListed(lists.browserTitleApps, identifier)
  ) {
    return "appOnly";
  }
  return "titles";
};

/**
 * The mode in effect: with details off, no app records titles, so every
 * app that is recorded at all records its name only.
 */
export const effectiveCaptureMode = (
  lists: CaptureLists,
  identifier: string,
): CaptureMode => {
  const saved = savedCaptureMode(lists, identifier);
  return lists.captureDetails || saved === "nothing" ? saved : "appOnly";
};

/** One existing native settings command and its arguments. */
export type CaptureModeCommand =
  | {
      command: "activity_remove_app_exclusion";
      args: { identifier: string };
    }
  | {
      command: "activity_set_app_detail_capture";
      args: {
        identifier: string;
        name: string;
        mode: "appNameOnly" | "includeDetails";
      };
    }
  | {
      command: "activity_set_browser_title_capture";
      args: { identifier: string; name: string; enabled: boolean };
    };

/**
 * The commands that move one app to `target`, narrowing before widening:
 * titles stop and the name-only choice lands before an exclusion is lifted,
 * so a command that fails halfway never leaves more recorded than either
 * the old or the new mode would. Excluding is not here: it first asks
 * whether to keep the app's history.
 */
export const captureModeCommands = (
  lists: CaptureLists,
  app: ActivityAppExclusion,
  target: Exclude<CaptureMode, "nothing">,
): CaptureModeCommand[] => {
  const { identifier, name } = app;
  const browser = isListed(lists.browserApps, identifier);
  const titles = isListed(lists.browserTitleApps, identifier);
  const nameOnly = isListed(lists.appNameOnlyApps, identifier);
  const commands: CaptureModeCommand[] = [];
  if (target === "appOnly") {
    if (browser && titles) {
      commands.push({
        command: "activity_set_browser_title_capture",
        args: { identifier, name, enabled: false },
      });
    }
    // A browser is set to its name too, so the choice is kept as made and
    // the Activity window does not ask about it again.
    if (!nameOnly) {
      commands.push({
        command: "activity_set_app_detail_capture",
        args: { identifier, name, mode: "appNameOnly" },
      });
    }
  } else {
    if (nameOnly) {
      commands.push({
        command: "activity_set_app_detail_capture",
        args: { identifier, name, mode: "includeDetails" },
      });
    }
    if (browser && !titles) {
      commands.push({
        command: "activity_set_browser_title_capture",
        args: { identifier, name, enabled: true },
      });
    }
  }
  if (isListed(lists.excludedApps, identifier)) {
    commands.push({
      command: "activity_remove_app_exclusion",
      args: { identifier },
    });
  }
  return commands;
};

/**
 * The browser to ask about: the first one in the day's activity, with
 * details on, that is neither chosen for titles nor set to its name, nor
 * excluded, and whose question was not put off in this window. At most one.
 */
export const undecidedBrowser = (
  day: Pick<
    ActivityDaySnapshot,
    | "appNameOnlyApps"
    | "browserApps"
    | "browserTitleApps"
    | "captureDetails"
    | "excludedApps"
    | "segments"
  >,
  dismissed: ReadonlySet<string>,
): ActivityAppExclusion | null => {
  if (!day.captureDetails) {
    return null;
  }
  const firstSeen = (identifier: string) => {
    let earliest: string | null = null;
    for (const segment of day.segments) {
      if (
        appKey(segment.appIdentifier) === appKey(identifier) &&
        (earliest === null || segment.start < earliest)
      ) {
        earliest = segment.start;
      }
    }
    return earliest;
  };
  return (
    day.browserApps
      .filter(
        (browser) =>
          !isListed(day.browserTitleApps, browser.identifier) &&
          !isListed(day.appNameOnlyApps, browser.identifier) &&
          !isListed(day.excludedApps, browser.identifier) &&
          !dismissed.has(appKey(browser.identifier)),
      )
      .flatMap((browser) => {
        const seen = firstSeen(browser.identifier);
        return seen === null ? [] : [{ browser, seen }];
      })
      .toSorted((left, right) => left.seen.localeCompare(right.seen))
      .at(0)?.browser ?? null
  );
};

/** The key a put-off question is remembered by. */
export const dismissedBrowserKey = appKey;

/**
 * Every app Settings lists: the chosen day's apps in their order, then the
 * apps with a saved choice of their own and the `kept` apps changed in this
 * view, by name, so a row does not vanish under the pointer when its last
 * saved choice is undone. Each app appears once.
 */
export const captureModeApps = (
  dayApps: readonly ActivityAppExclusion[],
  lists: CaptureLists,
  locale: string,
  kept: readonly ActivityAppExclusion[] = [],
): ActivityAppExclusion[] => {
  const seen = new Set(dayApps.map((app) => appKey(app.identifier)));
  const saved: ActivityAppExclusion[] = [];
  for (const app of [
    ...lists.browserTitleApps,
    ...lists.appNameOnlyApps,
    ...lists.excludedApps,
    ...kept,
  ]) {
    const key = appKey(app.identifier);
    if (!seen.has(key)) {
      seen.add(key);
      saved.push(app);
    }
  }
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  return [
    ...dayApps,
    ...saved.toSorted((left, right) => collator.compare(left.name, right.name)),
  ];
};

/** Whether the native side classified this app as a browser. */
export const isBrowserApp = (lists: CaptureLists, identifier: string) =>
  isListed(lists.browserApps, identifier);
