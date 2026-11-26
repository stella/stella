import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import type { OnboardingSnapshot } from "./onboarding-types";

/** Where a step that sets a feature up one choice per screen is among its
 *  screens. */
export type ScreenProgress = {
  /** Names the screens, such as "Dictation". */
  label: string;
  /** Each screen's name, in order. */
  names: readonly string[];
  position: number;
};

type StepFooterProps = {
  /** Why Back cannot act right now, such as while the step saves. */
  backDisabledReason?: string | undefined;
  onBack?: (() => void) | undefined;
  primary?: ReactNode;
  /** The screens of a step with several; their dots stand in for the
   *  step's own dot. */
  screens?: ScreenProgress | undefined;
  secondary?: ReactNode;
  /** The tour and its current step; absent outside the tour, where only
   *  the screens have dots. */
  snapshot?: OnboardingSnapshot | undefined;
};

/** Back, the step dots, and the step's own actions: one footer for every
 *  setup screen. */
export const StepFooter = ({
  backDisabledReason,
  onBack,
  primary,
  screens,
  secondary,
  snapshot,
}: StepFooterProps) => {
  const t = useTranslations("onboarding");
  return (
    <div className="mt-auto flex items-center gap-2 pt-5">
      {onBack ? (
        <Button
          disabled={backDisabledReason !== undefined}
          disabledReason={backDisabledReason}
          onClick={onBack}
          variant="ghost"
        >
          {t("back")}
        </Button>
      ) : null}
      <div className="flex flex-1 items-center justify-center gap-1.5">
        <FooterDots screens={screens} snapshot={snapshot} />
      </div>
      {secondary}
      {primary}
    </div>
  );
};

const FooterDots = ({
  screens,
  snapshot,
}: Pick<StepFooterProps, "screens" | "snapshot">) => {
  if (snapshot !== undefined) {
    return <TourDots screens={screens} snapshot={snapshot} />;
  }
  if (screens === undefined) {
    return null;
  }
  return <ScreenDots screens={screens} />;
};

const TourDots = ({
  screens,
  snapshot,
}: {
  screens: ScreenProgress | undefined;
  snapshot: OnboardingSnapshot;
}) => {
  const t = useTranslations("onboarding");
  const index = snapshot.steps.indexOf(snapshot.step);
  return (
    <>
      <span className="sr-only">
        {t("progress", { current: index + 1, total: snapshot.steps.length })}
      </span>
      {snapshot.steps.map((step, position) =>
        position === index && screens ? (
          <ScreenDots key={step} screens={screens} />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              position === index ? "bg-foreground" : "bg-border",
            )}
            key={step}
          />
        ),
      )}
    </>
  );
};

/** One dot per screen, the current one in full ink and the step's others
 *  a shade darker than the tour's. */
const ScreenDots = ({
  screens: { label, names, position },
}: {
  screens: ScreenProgress;
}) => {
  const t = useTranslations("onboarding");
  return (
    <nav aria-label={label}>
      <span className="sr-only">
        {t("progress", { current: position + 1, total: names.length })}
      </span>
      <ol className="flex items-center gap-1.5">
        {names.map((name, index) => (
          <li
            aria-current={index === position ? "step" : undefined}
            className={cn(
              "size-1.5 rounded-full",
              index === position ? "bg-foreground" : "bg-muted-foreground/48",
            )}
            data-slot="step"
            key={name}
          >
            <span className="sr-only">{name}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
};
