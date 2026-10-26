import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { StellaMark } from "@stll/ui/stella-mark";

import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import type { StepProps } from "./step-props";
import { StepFooter } from "./StepFooter";

export const WelcomeStep = ({ onContinue, snapshot }: StepProps) => {
  const t = useTranslations("onboarding");
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="bg-primary text-primary-foreground grid size-20 place-items-center rounded-2xl shadow-lg">
          <StellaMark className="size-11" />
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-balance">
          {t("welcomeTitle")}
        </h1>
        <p className="text-muted-foreground max-w-md text-sm leading-relaxed text-pretty">
          {DESKTOP_PLATFORM === "mac"
            ? t("welcomeBodyMac")
            : t("welcomeBodyOther")}
        </p>
      </div>
      <StepFooter
        primary={<Button onClick={onContinue}>{t("getStarted")}</Button>}
        snapshot={snapshot}
      />
    </>
  );
};
