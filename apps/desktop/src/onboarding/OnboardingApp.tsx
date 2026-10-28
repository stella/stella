import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import { ActivityStep } from "./ActivityStep";
import { ConnectStep } from "./ConnectStep";
import { DoneStep } from "./DoneStep";
import { FixView } from "./FixView";
import { HowItWorksStep } from "./HowItWorksStep";
import { IntroduceView } from "./IntroduceView";
import { reportOnboardingFailure } from "./onboarding-telemetry";
import {
  isOnboardingSnapshot,
  ONBOARDING_CHANGED_EVENT,
} from "./onboarding-types";
import type {
  OnboardingNavigation,
  OnboardingSnapshot,
  OnboardingStep,
} from "./onboarding-types";
import { PermissionsStep } from "./PermissionsStep";
import { TryItStep } from "./TryItStep";
import { WelcomeStep } from "./WelcomeStep";

type FlowState =
  | { status: "loading" }
  | { status: "failed" }
  | { snapshot: OnboardingSnapshot; status: "ready" };

/** The setup window. A retry remounts the flow, which reloads it. */
const OnboardingApp = () => {
  const [attempt, setAttempt] = useState(0);
  return (
    <OnboardingFlow
      key={attempt}
      onRetry={() => setAttempt((current) => current + 1)}
    />
  );
};

/** One step at a time, driven by the native flow. */
const OnboardingFlow = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations("onboarding");
  const [flow, setFlow] = useState<FlowState>({ status: "loading" });
  const operations = useRef(Promise.resolve());

  const enqueue = useCallback(async (operation: () => Promise<void>) => {
    const queued = operations.current.then(operation);
    operations.current = queued;
    await queued;
  }, []);

  useEffect(() => {
    let disposed = false;
    const refreshUnlessDisposed = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("onboarding_get_snapshot"),
      );
      if (disposed) {
        return;
      }
      if (Result.isError(result) || !isOnboardingSnapshot(result.value)) {
        reportOnboardingFailure();
        setFlow({ status: "failed" });
        return;
      }
      setFlow({ snapshot: result.value, status: "ready" });
    };
    const stopFlow = subscribeDesktopEvent({
      event: ONBOARDING_CHANGED_EVENT,
      handler: () => {
        void enqueue(refreshUnlessDisposed);
      },
      onError: reportOnboardingFailure,
    });
    // Linking happens in the browser; the account event brings it back here.
    const stopAccount = subscribeDesktopEvent({
      event: "desktop-account-changed",
      handler: () => {
        void enqueue(refreshUnlessDisposed);
      },
      onError: reportOnboardingFailure,
    });
    void enqueue(refreshUnlessDisposed);
    return () => {
      disposed = true;
      stopFlow();
      stopAccount();
    };
  }, [enqueue]);

  // `from` lets the native flow ignore a repeated or stale click instead of
  // moving twice.
  const advance = async (from: OnboardingStep, input: OnboardingNavigation) => {
    await enqueue(async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("onboarding_advance", { from, input }),
      );
      if (Result.isError(result) || !isOnboardingSnapshot(result.value)) {
        reportOnboardingFailure();
        setFlow({ status: "failed" });
        return;
      }
      setFlow({ snapshot: result.value, status: "ready" });
    });
  };

  const finish = async (openSettings: boolean) => {
    if (openSettings) {
      const settingsResult = await Result.tryPromise(async () =>
        invoke("onboarding_open_settings"),
      );
      if (Result.isError(settingsResult)) {
        reportOnboardingFailure();
      }
    }
    const result = await Result.tryPromise(async () =>
      invoke("onboarding_complete"),
    );
    if (Result.isError(result)) {
      reportOnboardingFailure();
    }
  };

  const close = async (
    command: "onboarding_dismiss" | "onboarding_open_activity",
  ) => {
    const result = await Result.tryPromise(async () => invoke(command));
    if (Result.isError(result)) {
      reportOnboardingFailure();
    }
  };

  return (
    <main
      className={cn(
        "bg-background text-foreground flex h-dvh flex-col px-10 pb-7",
        DESKTOP_PLATFORM === "mac" ? "pt-10" : "pt-6",
      )}
    >
      {flowContent()}
    </main>
  );

  function flowContent() {
    switch (flow.status) {
      case "loading":
        return null;
      case "failed":
        return (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm" role="alert">
              {t("errorLoad")}
            </p>
            <Button onClick={onRetry} variant="outline">
              {t("tryAgain")}
            </Button>
          </div>
        );
      case "ready":
        switch (flow.snapshot.mode.type) {
          case "fix":
            return (
              <FixView
                onDismiss={() => {
                  void close("onboarding_dismiss");
                }}
                permissions={flow.snapshot.mode.permissions}
              />
            );
          case "introduce":
            return (
              <IntroduceView
                activityPermissions={flow.snapshot.activityPermissions}
                onDismiss={() => {
                  void close("onboarding_dismiss");
                }}
                onOpenActivity={() => {
                  void close("onboarding_open_activity");
                }}
              />
            );
          case "tour":
            break;
          default:
            flow.snapshot.mode satisfies never;
            return panic("Unknown onboarding mode.");
        }
        return (
          <div
            className="motion-safe:animate-swap-in flex min-h-0 flex-1 flex-col"
            key={flow.snapshot.step}
          >
            {stepContent(flow.snapshot)}
          </div>
        );
      default:
        flow satisfies never;
        return panic("Unknown onboarding flow state.");
    }
  }

  function stepContent(snapshot: OnboardingSnapshot) {
    const props = {
      onBack: () => {
        void advance(snapshot.step, "back");
      },
      onContinue: () => {
        void advance(snapshot.step, "continue");
      },
      snapshot,
    };
    switch (snapshot.step) {
      case "welcome":
        return <WelcomeStep {...props} />;
      case "connect":
        return <ConnectStep {...props} />;
      case "howItWorks":
        return <HowItWorksStep {...props} />;
      case "activity":
        return <ActivityStep {...props} />;
      case "permissions":
        return <PermissionsStep {...props} />;
      case "tryIt":
        return <TryItStep {...props} />;
      case "done":
        return (
          <DoneStep
            onFinish={() => {
              void finish(false);
            }}
            onOpenSettings={() => {
              void finish(true);
            }}
            snapshot={snapshot}
          />
        );
      default:
        snapshot.step satisfies never;
        return panic("Unknown onboarding step.");
    }
  }
};

export default OnboardingApp;
