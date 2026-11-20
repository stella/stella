import { useState } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Step, Steps } from "@stll/ui/steps";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import type { Permission } from "../shared/permissions";
import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import {
  DICTATION_SETUP_SCREENS,
  dictationSetupScreens,
  microphoneScreenPermissions,
  moveFrom,
  shownScreen,
} from "./dictation-setup-steps";
import type { DictationSetupScreen } from "./dictation-setup-steps";
import { DictationSetupScreenBody } from "./DictationSetupScreens";
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

/** Grid columns for each number of screens, written out for Tailwind. */
const COLUMNS: Record<number, string> = {
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
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
  const screen = shownScreen(screens, requested);
  const position = screens.indexOf(screen);
  const last = position === screens.length - 1;

  const go = (direction: "back" | "continue") => {
    const move = moveFrom(screens, screen, direction);
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
        {t("dictationSetup.skipRest")}
      </Button>
    );
  })();

  return (
    <>
      <DictationSetupStepper
        label={label}
        position={position}
        screens={screens}
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

/** Where the step is among its screens: a short bar per screen with its
 *  name, the current one in full ink. */
const DictationSetupStepper = ({
  label,
  position,
  screens,
}: {
  label: string;
  position: number;
  screens: readonly DictationSetupScreen[];
}) => {
  const t = useTranslations("onboarding.dictationSetup");
  return (
    <nav aria-label={label} className="mb-4">
      <p className="text-muted-foreground mb-1.5 text-xs font-medium">
        {label}
        <span className="sr-only">
          {" "}
          {t("progress", { current: position + 1, total: screens.length })}
        </span>
      </p>
      <Steps
        className={cn("list-none ps-0", COLUMNS[screens.length])}
        markerStyle="none"
        variant="progress"
      >
        {screens.map((candidate, index) => (
          <Step
            aria-current={index === position ? "step" : undefined}
            className="min-w-0 ps-0 text-xs"
            key={candidate}
            status={stepStatus(index, position)}
          >
            <TruncatedText>{t(`screens.${candidate}`)}</TruncatedText>
          </Step>
        ))}
      </Steps>
    </nav>
  );
};

const stepStatus = (index: number, position: number) => {
  if (index < position) {
    return "completed";
  }
  return index === position ? "current" : "upcoming";
};

/** The dictation state could not be read: says so and offers to read again. */
const Unread = ({ onReload }: { onReload: () => void }) => {
  const t = useTranslations("onboarding");
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-destructive-foreground min-w-0 text-sm" role="alert">
        {t("errorLoad")}
      </p>
      <Button className="shrink-0" onClick={onReload} variant="outline">
        {t("tryAgain")}
      </Button>
    </div>
  );
};
