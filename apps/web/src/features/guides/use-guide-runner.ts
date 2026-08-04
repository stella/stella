import { useRef, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import type { GuideAnchorId } from "@/features/guides/guide-anchors";
import type { GuideEngine } from "@/features/guides/guide-engine";
import type {
  GuideSeed,
  GuideTour,
  GuideTourId,
} from "@/features/guides/guide-types";
import { guideAnchorSelector } from "@/features/guides/use-guide-anchor";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";

// Bounded wait so a mid-load, flag-gated, or removed anchor never blocks the
// tour: after the timeout the step is skipped and the run advances.
const STEP_POLL_TIMEOUT_MS = 2000;
const STEP_POLL_INTERVAL_MS = 100;

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const waitForAnchor = async (
  anchorId: GuideAnchorId,
): Promise<Element | null> => {
  const selector = guideAnchorSelector(anchorId);
  const deadline = Date.now() + STEP_POLL_TIMEOUT_MS;
  for (;;) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    // eslint-disable-next-line no-await-in-loop -- sequential by design: poll the DOM until the anchor mounts or the bounded deadline passes
    await delay(STEP_POLL_INTERVAL_MS);
  }
};

type GuideRunnerState =
  | { status: "idle" }
  | { status: "running"; tourId: GuideTourId };

type UseGuideRunnerOptions = {
  // Invoked once a tour reaches its final step (not on early dismiss).
  onCompleted: (tourId: GuideTourId) => void;
};

export type GuideRunner = {
  runTour: (tour: GuideTour) => void;
  activeTourId: GuideTourId | null;
  isRunning: boolean;
};

export const useGuideRunner = ({
  onCompleted,
}: UseGuideRunnerOptions): GuideRunner => {
  const navigate = useNavigate();
  const t = useTranslations();
  const analytics = useAnalytics();
  const [state, setState] = useState<GuideRunnerState>({ status: "idle" });
  const engineRef = useRef<GuideEngine | null>(null);
  // Set to the active step's dismiss resolver while a popover is shown so the
  // engine's single `onDismiss` can settle the current step.
  const dismissRef = useRef<() => void>(() => undefined);

  const applySeed = (seed: GuideSeed | undefined) => {
    if (!seed) {
      return;
    }
    switch (seed.kind) {
      case "none":
        return;
      case "fill-input": {
        const target = document.querySelector(guideAnchorSelector(seed.anchor));
        // Guarded: only a real text input is seeded; a rich-text or missing
        // target is a no-op so a demo seed can never throw.
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        ) {
          target.value = t(seed.valueKey);
          target.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }
      default:
        seed satisfies never;
    }
  };

  const runTour = async (tour: GuideTour) => {
    if (engineRef.current) {
      return;
    }
    setState({ status: "running", tourId: tour.id });

    const { createGuideEngine } =
      await import("@/features/guides/guide-engine");
    const engine = createGuideEngine({
      onDismiss: () => dismissRef.current(),
    });
    engineRef.current = engine;

    let shownAnyStep = false;
    let dismissed = false;
    const total = tour.steps.length;

    try {
      for (let index = 0; index < total; index++) {
        const step = tour.steps.at(index);
        if (!step) {
          continue;
        }
        if (step.route) {
          // eslint-disable-next-line no-await-in-loop -- sequential by design: each step navigates then waits before the next
          await navigate({ to: step.route });
        }
        // eslint-disable-next-line no-await-in-loop -- sequential by design: resolve this step's anchor before showing it
        const element = await waitForAnchor(step.anchor);
        if (!element) {
          analytics.captureGuideStepSkipped({
            tourId: tour.id,
            anchorId: step.anchor,
            reason: "anchor-missing",
          });
          continue;
        }

        applySeed(step.seed);
        shownAnyStep = true;

        // eslint-disable-next-line no-await-in-loop -- sequential by design: block on the user advancing or dismissing this step
        const outcome = await new Promise<"next" | "close">((resolve) => {
          dismissRef.current = () => resolve("close");
          engine.showStep({
            element,
            title: t(step.titleKey),
            body: t(step.bodyKey),
            placement: step.placement,
            progressText: t("common.stepProgress", {
              current: String(index + 1),
              total: String(total),
            }),
            isLastStep: index === total - 1,
            nextLabel: t("common.next"),
            doneLabel: t("common.done"),
            onNext: () => resolve("next"),
          });
        });
        dismissRef.current = () => undefined;

        if (outcome === "close") {
          dismissed = true;
          break;
        }
      }
    } finally {
      engine.destroy();
      engineRef.current = null;
      setState({ status: "idle" });
    }

    if (dismissed) {
      return;
    }
    if (!shownAnyStep) {
      // Every step diverged from the live surface: end cleanly, surface it.
      analytics.captureGuideStepSkipped({
        tourId: tour.id,
        anchorId: tour.steps.at(0)?.anchor ?? "",
        reason: "tour-empty",
      });
      stellaToast.add({ title: t("guides.unavailable"), type: "info" });
      return;
    }
    onCompleted(tour.id);
  };

  const start = (tour: GuideTour) => {
    detached(runTour(tour), "useGuideRunner");
  };

  return {
    runTour: start,
    activeTourId: state.status === "running" ? state.tourId : null,
    isRunning: state.status === "running",
  };
};
