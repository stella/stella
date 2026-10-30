import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CheckCircle2Icon } from "@stll/ui/icons";

import { PermissionsSection } from "../mainview/PermissionsSection";
import type { DesktopPlatform } from "../shared/shortcut-keys";
import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import type { OnboardingSnapshot } from "./onboarding-types";
import { StepFooter } from "./StepFooter";
import { TrayLocationPreview } from "./TrayLocationPreview";

const DONE_BODY = {
  mac: "doneBodyMac",
  other: "doneBodyOther",
  windows: "doneBodyWindows",
} as const satisfies Record<DesktopPlatform, string>;

/** Asked again here: the app reaches the user through them once set up. */
const DONE_PERMISSIONS = ["notifications"] as const;

type DoneStepProps = {
  onFinish: () => void;
  onOpenSettings: () => void;
  snapshot: OnboardingSnapshot;
};

/**
 * The last step: where the app lives (its icon, drawn where the OS reports
 * it) and the notifications it uses from now on, with their live status.
 */
export const DoneStep = ({
  onFinish,
  onOpenSettings,
  snapshot,
}: DoneStepProps) => {
  const t = useTranslations("onboarding");
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        {snapshot.trayLocation ? (
          <TrayLocationPreview location={snapshot.trayLocation} />
        ) : (
          <CheckCircle2Icon
            aria-hidden="true"
            className="text-success-foreground size-14"
          />
        )}
        <h1 className="mt-2 text-xl font-semibold">{t("doneTitle")}</h1>
        <p className="text-muted-foreground max-w-md text-sm leading-relaxed text-pretty">
          {t(DONE_BODY[DESKTOP_PLATFORM])}
        </p>
        <div
          className="bg-card mt-2 w-full max-w-md overflow-hidden rounded-xl border text-start empty:hidden"
          data-done-permissions=""
        >
          <PermissionsSection
            only={DONE_PERMISSIONS}
            window={DESKTOP_TELEMETRY_WINDOWS.onboarding}
          />
        </div>
      </div>
      <StepFooter
        primary={<Button onClick={onFinish}>{t("done")}</Button>}
        secondary={
          <Button onClick={onOpenSettings} variant="outline">
            {t("openSettings")}
          </Button>
        }
        snapshot={snapshot}
      />
    </>
  );
};
