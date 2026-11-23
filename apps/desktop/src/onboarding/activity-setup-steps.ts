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

/**
 * The screens that apply now, in order. Window details are left out where
 * this computer cannot read them; stella AI drafts where the account cannot
 * choose them.
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
        return state.detailsAccess !== "unavailable";
      case "aiDrafts":
        return state.aiDrafts === "offered";
      default:
        screen satisfies never;
        return panic("Unknown activity setup screen.");
    }
  });

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
