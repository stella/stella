import { useState } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { aiDraftsChoice } from "../activity/billing-draft-logic";
import type { BillingDraftSettingsControl } from "../activity/billing-draft-settings";
import type { Permission } from "../shared/permissions";
import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import {
  ACTIVITY_SETUP_SCREENS,
  activitySetupScreens,
  detailsScreenPermissions,
  shownDetailsChoice,
} from "./activity-setup-steps";
import type {
  ActivitySetupScreen,
  DetailsAnswer,
} from "./activity-setup-steps";
import { ActivitySetupScreenBody } from "./ActivitySetupScreens";
import { moveFrom, shownScreen } from "./setup-screens";
import { Unread } from "./SetupScreenParts";
import type { ScreenProgress } from "./StepFooter";
import type { ActivitySetupControls } from "./use-activity-setup";

/** The step's own actions, for the footer the step draws them in. */
type ActivitySetupActions = {
  onBack: (() => void) | undefined;
  /** Why Back cannot act right now: recording is starting. */
  backDisabledReason: string | undefined;
  /** Whether recording has started, paused or not. */
  recording: boolean;
  primary: ReactNode;
  /** Where the screen on view is among the screens; none before they
   *  load. */
  screens: ScreenProgress | undefined;
  secondary: ReactNode;
};

type ActivitySetupFlowProps = {
  controls: ActivitySetupControls;
  drafts: BillingDraftSettingsControl;
  /** What leaving forward is called: Continue in the tour, Done after it. */
  finishLabel: string;
  /** Names the screens, such as "Activity". */
  label: string;
  /** Before the first screen; absent where nothing comes before. */
  onLeaveBack?: (() => void) | undefined;
  /** After the last screen, or skipping the rest. */
  onLeaveForward: () => void;
  /** The permissions Activity needs here, as the native side lists them. */
  permissions: readonly Permission[];
  /** The line under the first screen's title. */
  recordingBody: string;
  /** Draws the step's footer around its actions. */
  renderFooter: (actions: ActivitySetupActions) => ReactNode;
  /** What leaving without recording is called: Skip, or Later. */
  skipLabel: string;
};

/**
 * Activity set up one choice per screen, as Dictation is: what it records
 * and starting it, window details with the access a Mac needs for them,
 * calls, and consent to stella AI drafts. Each screen writes what Settings →
 * Activity reads the moment it changes, so leaving at any screen keeps what
 * was chosen and the rest keeps its default. The details screen continues
 * only once one of its answers is picked.
 */
export const ActivitySetupFlow = ({
  controls,
  drafts,
  finishLabel,
  label,
  onLeaveBack,
  onLeaveForward,
  permissions,
  recordingBody,
  renderFooter,
  skipLabel,
}: ActivitySetupFlowProps) => {
  const t = useTranslations("onboarding");
  const activityT = useTranslations("activity");
  const [requested, setRequested] = useState<ActivitySetupScreen>(
    ACTIVITY_SETUP_SCREENS[0],
  );
  const [busy, setBusy] = useState(false);
  const [detailsAnswer, setDetailsAnswer] =
    useState<DetailsAnswer>("unanswered");
  const { snapshot } = controls;

  if (snapshot === null) {
    return (
      <>
        <h1 className="text-xl font-semibold">{label}</h1>
        {controls.unread ? (
          <div className="mt-4">
            <Unread onReload={controls.reload} />
          </div>
        ) : null}
        {renderFooter({
          backDisabledReason: undefined,
          onBack: onLeaveBack,
          primary: null,
          recording: false,
          screens: undefined,
          secondary: (
            <Button onClick={onLeaveForward} variant="ghost">
              {skipLabel}
            </Button>
          ),
        })}
      </>
    );
  }

  const screens = activitySetupScreens({
    aiDrafts: aiDraftsChoice(drafts.settings),
    detailsAccess: snapshot.detailsAccess,
  });
  const screen = shownScreen({
    order: ACTIVITY_SETUP_SCREENS,
    screen: requested,
    screens,
  });
  const position = screens.indexOf(screen);
  const last = position === screens.length - 1;
  const recording = snapshot.recordingStatus !== "off";

  const go = (direction: "back" | "continue") => {
    const move = moveFrom({
      direction,
      order: ACTIVITY_SETUP_SCREENS,
      screen,
      screens,
    });
    switch (move.type) {
      case "screen":
        setRequested(move.screen);
        return;
      case "leaveBack":
        onLeaveBack?.();
        return;
      case "leaveForward":
        onLeaveForward();
        return;
      default:
        move satisfies never;
        panic("Unknown activity setup move.");
    }
  };

  // The first screen's button starts recording, as the Activity window's
  // own Start recording does; every later screen only changes a choice.
  const onContinue = async () => {
    if (!recording) {
      setBusy(true);
      const started = await controls.start();
      setBusy(false);
      if (!started) {
        return;
      }
    }
    go("continue");
  };

  const primaryLabel = (() => {
    if (!recording) {
      return activityT("welcomeStart");
    }
    return last ? finishLabel : t("continue");
  })();

  // While recording starts, nothing may leave the screen: the start would
  // land after the step it belongs to.
  const starting = busy ? t("activitySetup.starting") : undefined;
  const detailsChoice = shownDetailsChoice(
    detailsAnswer,
    snapshot.captureDetails,
  );
  const awaitingDetails = screen === "details" && detailsChoice === "none";

  const secondary = (() => {
    if (!recording) {
      return (
        <Button
          disabled={busy}
          disabledReason={starting}
          onClick={onLeaveForward}
          variant="ghost"
        >
          {skipLabel}
        </Button>
      );
    }
    return last ? null : (
      <Button onClick={onLeaveForward} variant="ghost">
        {t("skipRest")}
      </Button>
    );
  })();

  return (
    <>
      <div
        className="motion-safe:animate-swap-in flex min-h-0 flex-1 flex-col"
        data-activity-screen={screen}
        key={screen}
      >
        <ActivitySetupScreenBody
          controls={controls}
          detailsAnswer={detailsAnswer}
          drafts={drafts}
          onDetailsAnswer={() => {
            setDetailsAnswer("answered");
          }}
          permissions={detailsScreenPermissions({
            captureDetails: detailsChoice === "withDetails",
            permissions,
            platform: DESKTOP_PLATFORM,
          })}
          recordingBody={recordingBody}
          screen={screen}
          snapshot={snapshot}
        />
        {controls.failed ? (
          <p className="text-destructive-foreground mt-3 text-sm" role="alert">
            {activityT("errorUpdate")}
          </p>
        ) : null}
        {controls.unread ? (
          <div className="mt-3">
            <Unread onReload={controls.reload} />
          </div>
        ) : null}
      </div>
      {renderFooter({
        backDisabledReason: starting,
        onBack:
          position === 0 && onLeaveBack === undefined
            ? undefined
            : () => {
                go("back");
              },
        primary: (
          <Button
            disabled={busy || awaitingDetails}
            disabledReason={
              starting ??
              (awaitingDetails ? t("activitySetup.details.choose") : undefined)
            }
            onClick={() => {
              void onContinue();
            }}
          >
            {primaryLabel}
          </Button>
        ),
        recording,
        screens: {
          label,
          names: screens.map((candidate) =>
            t(`activitySetup.screens.${candidate}`),
          ),
          position,
        },
        secondary,
      })}
    </>
  );
};
