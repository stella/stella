import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import type { OnboardingSnapshot } from "./onboarding-types";

type StepFooterProps = {
  onBack?: () => void;
  primary?: ReactNode;
  secondary?: ReactNode;
  snapshot: OnboardingSnapshot;
};

/** Back, the step dots, and the step's own actions. */
export const StepFooter = ({
  onBack,
  primary,
  secondary,
  snapshot,
}: StepFooterProps) => {
  const t = useTranslations("onboarding");
  const index = snapshot.steps.indexOf(snapshot.step);
  return (
    <div className="mt-auto flex items-center gap-2 pt-5">
      {onBack ? (
        <Button onClick={onBack} size="sm" variant="ghost">
          {t("back")}
        </Button>
      ) : null}
      <div className="flex flex-1 justify-center gap-1.5">
        <span className="sr-only">
          {t("progress", { current: index + 1, total: snapshot.steps.length })}
        </span>
        {snapshot.steps.map((step, position) => (
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              position === index ? "bg-foreground" : "bg-border",
            )}
            key={step}
          />
        ))}
      </div>
      {secondary}
      {primary}
    </div>
  );
};
