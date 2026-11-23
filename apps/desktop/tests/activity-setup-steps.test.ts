import { describe, expect, test } from "bun:test";

import { ACTIVITY_DETAILS_ACCESS } from "../src/activity/activity-types";
import { aiDraftsChoice } from "../src/activity/billing-draft-logic";
import type { AiDraftsChoice } from "../src/activity/billing-draft-logic";
import type { BillingDraftSettings } from "../src/activity/billing-draft-settings";
import type { DraftConsentStatus } from "../src/activity/billing-draft-transport";
import {
  ACTIVITY_SETUP_SCREENS,
  activitySetupScreens,
  detailsScreenPermissions,
} from "../src/onboarding/activity-setup-steps";
import type { ActivitySetupScreen } from "../src/onboarding/activity-setup-steps";
import { moveFrom, shownScreen } from "../src/onboarding/setup-screens";

const move = (
  screens: readonly ActivitySetupScreen[],
  screen: ActivitySetupScreen,
  direction: "back" | "continue",
) => moveFrom({ direction, order: ACTIVITY_SETUP_SCREENS, screen, screens });

const ready = (
  settings: Partial<Extract<BillingDraftSettings, { type: "ready" }>>,
): BillingDraftSettings => ({
  consent: "revoked",
  mode: "plain",
  preference: null,
  type: "ready",
  ...settings,
});

describe("the screens of the Activity step", () => {
  test("come in the order overview, details, calls, AI drafts", () => {
    expect(
      activitySetupScreens({ aiDrafts: "offered", detailsAccess: "ready" }),
    ).toEqual([...ACTIVITY_SETUP_SCREENS]);
  });

  test("always start with the overview and end with calls or AI drafts", () => {
    for (const detailsAccess of ACTIVITY_DETAILS_ACCESS) {
      for (const aiDrafts of ["offered", "notOffered"] as const) {
        const screens = activitySetupScreens({ aiDrafts, detailsAccess });
        expect(screens.at(0)).toBe("recording");
        expect(screens).toContain("calls");
        expect(screens.at(-1)).toBe(
          aiDrafts === "offered" ? "aiDrafts" : "calls",
        );
      }
    }
  });

  test("leave out details where this computer cannot read them", () => {
    expect(
      activitySetupScreens({
        aiDrafts: "notOffered",
        detailsAccess: "unavailable",
      }),
    ).toEqual(["recording", "calls"]);
    for (const detailsAccess of [
      "disabled",
      "ready",
      "accessibilityRequired",
    ] as const) {
      expect(
        activitySetupScreens({ aiDrafts: "notOffered", detailsAccess }),
      ).toContain("details");
    }
  });
});

describe("the AI drafts screen", () => {
  test("is offered where the firm lets the account draft", () => {
    expect(aiDraftsChoice(ready({ mode: "plain" }))).toBe("offered");
    expect(aiDraftsChoice(ready({ mode: "off" }))).toBe("notOffered");
  });

  test("stays while consent exists, so it can be withdrawn", () => {
    const withDraftingOff = {
      granted: "offered",
      "pending-withdrawal": "offered",
      "withdrawal-unconfirmed": "offered",
      revoked: "notOffered",
      "pending-grant": "notOffered",
      "grant-refused": "notOffered",
      unavailable: "notOffered",
    } as const satisfies Record<DraftConsentStatus, AiDraftsChoice>;
    const isStatus = (key: string): key is DraftConsentStatus =>
      key in withDraftingOff;
    for (const consent of Object.keys(withDraftingOff).filter(isStatus)) {
      expect(aiDraftsChoice(ready({ consent, mode: "off" }))).toBe(
        withDraftingOff[consent],
      );
    }
  });

  test("is not offered before or without the account's settings", () => {
    for (const type of ["loading", "unavailable", "failed"] as const) {
      expect(aiDraftsChoice({ type })).toBe("notOffered");
    }
  });
});

describe("the details screen's permissions", () => {
  test("ask for Accessibility on a Mac while details are recorded", () => {
    expect(
      detailsScreenPermissions({
        captureDetails: true,
        permissions: ["notifications", "accessibility"],
        platform: "mac",
      }),
    ).toEqual(["accessibility"]);
  });

  test("ask for nothing with details off, elsewhere, or when not needed", () => {
    expect(
      detailsScreenPermissions({
        captureDetails: false,
        permissions: ["accessibility"],
        platform: "mac",
      }),
    ).toEqual([]);
    expect(
      detailsScreenPermissions({
        captureDetails: true,
        permissions: ["accessibility"],
        platform: "windows",
      }),
    ).toEqual([]);
    expect(
      detailsScreenPermissions({
        captureDetails: true,
        permissions: [],
        platform: "mac",
      }),
    ).toEqual([]);
  });
});

describe("moving between the screens", () => {
  const all = activitySetupScreens({
    aiDrafts: "offered",
    detailsAccess: "ready",
  });

  test("Continue walks the screens in order, then leaves the step", () => {
    const visited: ActivitySetupScreen[] = [];
    let screen = all.at(0);
    while (screen !== undefined) {
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

  test("Back from the overview leaves for the step before", () => {
    expect(move(all, "recording", "back")).toEqual({ type: "leaveBack" });
  });

  test("AI drafts that stop applying while shown hand over to calls", () => {
    const withoutDrafts = activitySetupScreens({
      aiDrafts: "notOffered",
      detailsAccess: "ready",
    });
    expect(
      shownScreen({
        order: ACTIVITY_SETUP_SCREENS,
        screen: "aiDrafts",
        screens: withoutDrafts,
      }),
    ).toBe("calls");
    expect(move(withoutDrafts, "aiDrafts", "continue")).toEqual({
      type: "leaveForward",
    });
  });
});
