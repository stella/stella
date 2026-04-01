import { useEffect, useState } from "react";

import { useTranslations } from "use-intl";

import { StellaWordmark } from "@/components/stella-wordmark";

export type Phase = "org" | "invites" | "done";

type CreatingStepProps = {
  currentPhase: Phase;
  progress: number;
};

/**
 * Full-screen "setting up" step with animated progress bar
 * and rotating status messages.
 */
export const CreatingStep = ({ currentPhase, progress }: CreatingStepProps) => {
  const t = useTranslations();
  const [showPulse, setShowPulse] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => setShowPulse((v) => !v), 1200);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex w-full max-w-[400px] flex-col items-center text-center">
        <StellaWordmark
          className="text-foreground mb-10 h-7 w-auto transition-opacity duration-700"
          style={{ opacity: showPulse ? 1 : 0.4 }}
        />

        {/* Progress bar */}
        <div className="bg-border h-1.5 w-full overflow-hidden rounded-full">
          <div
            className="bg-foreground h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>

        <p className="text-muted-foreground mt-4 text-sm">
          {currentPhase === "org" && t("onboarding.creating.org")}
          {currentPhase === "invites" && t("onboarding.creating.invites")}
          {currentPhase === "done" && t("onboarding.creating.done")}
        </p>

        <p className="text-muted-foreground/50 mt-8 text-xs">
          {t("onboarding.creatingTrust")}
        </p>
      </div>
    </div>
  );
};
