import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { CheckCircle2Icon } from "@stll/ui/icons";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import { StellaAppIcon } from "../shared/StellaAppIcon";
import { reportOnboardingFailure } from "./onboarding-telemetry";

/** Mirrors `CHANGED_EVENT` in `accessibility_guide.rs`; payload-free. */
const GUIDE_CHANGED_EVENT = "accessibility-guide-changed";

type GuideStatus = "waiting" | "allowed";

const isGuideStatus = (value: unknown): value is GuideStatus =>
  value === "waiting" || value === "allowed";

/**
 * The panel docked under System Settings: what to switch on there, and that
 * it worked. The native side positions and closes it.
 */
const AccessibilityGuideApp = () => {
  const t = useTranslations("onboarding");
  const [status, setStatus] = useState<GuideStatus>("waiting");

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("accessibility_guide_get_state"),
      );
      if (disposed) {
        return;
      }
      if (Result.isError(result) || !isGuideStatus(result.value)) {
        reportOnboardingFailure();
        return;
      }
      setStatus(result.value);
    };
    const stopListening = subscribeDesktopEvent({
      event: GUIDE_CHANGED_EVENT,
      handler: () => {
        void refresh();
      },
      onError: reportOnboardingFailure,
    });
    void refresh();
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  return (
    <main
      aria-live="polite"
      className="accessibility-guide-window bg-background/90 text-foreground flex h-dvh items-center gap-3 rounded-2xl border px-4 backdrop-blur"
    >
      {status === "allowed" ? (
        <>
          <CheckCircle2Icon
            aria-hidden="true"
            className="text-success-foreground size-6 shrink-0"
          />
          <p className="text-sm font-medium">{t("guideAllowed")}</p>
        </>
      ) : (
        <>
          <StellaAppIcon className="size-8 rounded-lg" />
          <p className="text-sm leading-snug">{t("guideWaiting")}</p>
        </>
      )}
    </main>
  );
};

export default AccessibilityGuideApp;
