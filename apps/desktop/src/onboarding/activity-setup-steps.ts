/**
 * The screens the Activity step walks through, in order, and which of them
 * apply. Like the Dictation step's, they live inside the one step the
 * native flow knows and follow the live state: a screen whose choice would
 * change nothing here is left out, the way Settings → Activity hides it.
 */

import { panic } from "better-result";

import type { ActivityDetailsAccess } from "../activity/activity-types";
import type { AiDraftsChoice } from "../activity/billing-draft-logic";
import type { Permission } from "../shared/permissions";
import type { DesktopPlatform } from "../shared/shortcut-keys";

export const ACTIVITY_SETUP_SCREENS = [
  "recording",
  "details",
  "calls",
  "aiDrafts",
] as const;

export type ActivitySetupScreen = (typeof ACTIVITY_SETUP_SCREENS)[number];

/** The parts of the live state that decide which screens apply. */
export type ActivitySetupState = {
  aiDrafts: AiDraftsChoice;
  detailsAccess: ActivityDetailsAccess;
};

/** Whether the user chooses window details: not where this computer cannot
 *  read them, nor where managed policy keeps them off. */
const detailsChoiceApplies = (access: ActivityDetailsAccess) => {
  switch (access) {
    case "disabled":
    case "ready":
    case "accessibilityRequired":
      return true;
    case "unavailable":
    case "managed":
      return false;
    default:
      access satisfies never;
      return panic("Unknown activity details access.");
  }
};

/**
 * The screens that apply now, in order. Window details are left out where
 * this computer cannot read them or managed policy keeps them off; stella AI
 * drafts where the account cannot choose them.
 */
export const activitySetupScreens = (
  state: ActivitySetupState,
): ActivitySetupScreen[] =>
  ACTIVITY_SETUP_SCREENS.filter((screen) => {
    switch (screen) {
      case "recording":
      case "calls":
        return true;
      case "details":
        return detailsChoiceApplies(state.detailsAccess);
      case "aiDrafts":
        return state.aiDrafts === "offered";
      default:
        screen satisfies never;
        return panic("Unknown activity setup screen.");
    }
  });

/** The details screen's two answers, in the order it lists them: app names
 *  only, or window titles and document names too. */
export const DETAILS_CHOICES = ["appNamesOnly", "withDetails"] as const;
export type DetailsChoice = (typeof DETAILS_CHOICES)[number];

/** Each answer as the stored choice says it. */
export const DETAILS_CHOICE_CAPTURES = {
  appNamesOnly: false,
  withDetails: true,
} as const satisfies Record<DetailsChoice, boolean>;

/** Whether the user picked an answer on the details screen during this
 *  setup. Until then neither answer shows as chosen, whatever is stored,
 *  and the screen cannot be continued. */
export type DetailsAnswer = "unanswered" | "answered";

/** The answer the details screen shows as chosen: none until the user
 *  picks one, then the stored choice. */
export const shownDetailsChoice = (
  answer: DetailsAnswer,
  captureDetails: boolean,
): DetailsChoice | "none" => {
  switch (answer) {
    case "unanswered":
      return "none";
    case "answered":
      return captureDetails ? "withDetails" : "appNamesOnly";
    default:
      answer satisfies never;
      return panic("Unknown activity details answer.");
  }
};

type DetailsPermissionsArgs = {
  captureDetails: boolean;
  /** The permissions Activity needs here, as the native side lists them. */
  permissions: readonly Permission[];
  platform: DesktopPlatform;
};

/**
 * The permissions the details screen asks for: Accessibility, which only
 * macOS gates, and only while window details are recorded.
 */
export const detailsScreenPermissions = ({
  captureDetails,
  permissions,
  platform,
}: DetailsPermissionsArgs): Permission[] =>
  captureDetails && platform === "mac"
    ? permissions.filter((permission) => permission === "accessibility")
    : [];
