import { useState } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { Permission } from "../shared/permissions";
import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import {
  DICTATION_SETUP_SCREENS,
  dictationSetupScreens,
  microphoneScreenPermissions,
} from "./dictation-setup-steps";
import type { DictationSetupScreen } from "./dictation-setup-steps";
import { DictationSetupScreenBody } from "./DictationSetupScreens";
import { moveFrom, shownScreen } from "./setup-screens";
import { SetupStepper, Unread } from "./SetupScreenParts";
import type { DictationControls } from "./use-dictation";

/** The step's own actions, for the footer the step draws them in. */
type DictationSetupActions = {
  onBack: (() => void) | undefined;
  primary: ReactNode;
  secondary: ReactNode;
};

type DictationSetupFlowProps = {
  controls: DictationControls;
  /** What leaving forward is called: Continue in the tour, Done after it. */
  finishLabel: string;
  /** Names the steps above the title, such as "Dictation". */
  label: string;
  /** Before the first screen; absent where nothing comes before. */
  onLeaveBack?: (() => void) | undefined;
  /** After the last screen, or skipping the rest. */
  onLeaveForward: () => void;
  /** The permissions dictation needs here, as the native side lists them. */
  permissions: readonly Permission[];
  /** Draws the step's footer around its actions. */
  renderFooter: (actions: DictationSetupActions) => ReactNode;
  /** What leaving without dictation is called: Skip, or Later. */
  skipLabel: string;
};

/**
 * Dictation set up one choice per screen: the microphone and the
 * permissions, where speech is transcribed, AI cleanup and the app it
 * writes for, more context for cleanup, and custom words. Each screen
 * writes the same stored preference as Settings → Dictation the moment it
 * changes, so leaving at any screen keeps what was chosen and the rest
 * keeps its default. The screens follow the live state: one whose setting
 * would change nothing is left out.
 */
export const DictationSetupFlow = ({
  controls,
  finishLabel,
  label,
  onLeaveBack,
  onLeaveForward,
  permissions,
  renderFooter,
  skipLabel,
}: DictationSetupFlowProps) => {
  const t = useTranslations("onboarding");
  const [requested, setRequested] = useState<DictationSetupScreen>(
    DICTATION_SETUP_SCREENS[0],
  );
  const [busy, setBusy] = useState(false);
  const { snapshot } = controls;

  if (snapshot === null || !snapshot.available) {
    return (
      <>
        <h1 className="text-xl font-semibold">{label}</h1>
        {snapshot === null && controls.unread ? (
          <div className="mt-4">
            <Unread onReload={controls.reload} />
          </div>
        ) : null}
        {renderFooter({
          onBack: onLeaveBack,
          primary: null,
          secondary: (
            <Button onClick={onLeaveForward} variant="ghost">
              {skipLabel}
            </Button>
          ),
        })}
      </>
    );
  }

  const screens = dictationSetupScreens(snapshot);
  const screen = shownScreen({
    order: DICTATION_SETUP_SCREENS,
    screen: requested,
    screens,
  });
  const position = screens.indexOf(screen);
  const last = position === screens.length - 1;

  const go = (direction: "back" | "continue") => {
    const move = moveFrom({
      direction,
      order: DICTATION_SETUP_SCREENS,
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
        panic("Unknown dictation setup move.");
    }
  };

  // The first Continue is the one that turns dictation on; every later
  // screen only changes what it shows.
  const onContinue = async () => {
    if (!snapshot.enabled) {
      setBusy(true);
      const on = await controls.turnOn();
      setBusy(false);
      if (!on) {
        return;
      }
    }
    go("continue");
  };

  const secondary = (() => {
    if (!snapshot.enabled) {
      return (
        <Button onClick={onLeaveForward} variant="ghost">
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
      <SetupStepper
        label={label}
        names={screens.map((candidate) =>
          t(`dictationSetup.screens.${candidate}`),
        )}
        position={position}
      />
      <div
        className="motion-safe:animate-swap-in flex min-h-0 flex-1 flex-col"
        data-dictation-screen={screen}
        key={screen}
      >
        <DictationSetupScreenBody
          controls={controls}
          permissions={microphoneScreenPermissions(
            permissions,
            DESKTOP_PLATFORM,
          )}
          screen={screen}
          snapshot={snapshot}
        />
        {controls.failed ? (
          <p className="text-destructive-foreground mt-3 text-sm" role="alert">
            {t("dictationFailed")}
          </p>
        ) : null}
        {controls.unread ? (
          <div className="mt-3">
            <Unread onReload={controls.reload} />
          </div>
        ) : null}
      </div>
      {renderFooter({
        onBack:
          position === 0 && onLeaveBack === undefined
            ? undefined
            : () => {
                go("back");
              },
        primary: (
          <Button
            disabled={busy}
            disabledReason={t("enablingDictation")}
            onClick={() => {
              void onContinue();
            }}
          >
            {last ? finishLabel : t("continue")}
          </Button>
        ),
        secondary,
      })}
    </>
  );
};
