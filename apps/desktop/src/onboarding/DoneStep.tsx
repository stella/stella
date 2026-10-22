import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CheckCircle2Icon } from "@stll/ui/icons";

import type { DesktopPlatform } from "../shared/shortcut-keys";
import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import type { OnboardingSnapshot } from "./onboarding-types";
import { StepFooter } from "./StepFooter";

const DONE_BODY = {
  mac: "doneBodyMac",
  other: "doneBodyOther",
  windows: "doneBodyWindows",
} as const satisfies Record<DesktopPlatform, string>;

type DoneStepProps = {
  onFinish: () => void;
  onOpenSettings: () => void;
  snapshot: OnboardingSnapshot;
};

export const DoneStep = ({
  onFinish,
  onOpenSettings,
  snapshot,
}: DoneStepProps) => {
  const t = useTranslations("onboarding");
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <CheckCircle2Icon
          aria-hidden="true"
          className="text-success-foreground size-14"
        />
        <h1 className="text-xl font-semibold">{t("doneTitle")}</h1>
        <p className="text-muted-foreground max-w-md text-sm leading-relaxed text-pretty">
          {t(DONE_BODY[DESKTOP_PLATFORM])}
        </p>
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
