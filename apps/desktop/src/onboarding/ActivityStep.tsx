import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { ActivityExplainer } from "./ActivityExplainer";
import type { StepProps } from "./step-props";
import { StepFooter } from "./StepFooter";

export const ActivityStep = ({ onBack, onContinue, snapshot }: StepProps) => {
  const t = useTranslations("onboarding");
  return (
    <>
      <h1 className="text-xl font-semibold">{t("activityTitle")}</h1>
      <p className="text-muted-foreground mt-1 mb-4 text-sm text-pretty">
        {t("activityBody")}
      </p>
      <ActivityExplainer permissions={snapshot.activityPermissions} />
      <StepFooter
        onBack={onBack}
        primary={<Button onClick={onContinue}>{t("continue")}</Button>}
        snapshot={snapshot}
      />
    </>
  );
};
