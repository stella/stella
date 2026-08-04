import { useRef, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import type { GuideAnchorId } from "@/features/guides/guide-anchors";
import type { GuideEngine } from "@/features/guides/guide-engine";
import type {
  GuideInteraction,
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

// The ARIA roles a disclosure trigger reveals. Used to tell a step that lives
// inside a surface the tour opened from one that lives on the page behind it,
// which is what decides whether the surface stays open or is closed again.
const REVEALED_SURFACE_SELECTOR =
  '[role="menu"],[role="listbox"],[role="dialog"]';

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
    // The disclosure trigger this run clicked open, while the tour is still
    // teaching what that surface contains. Kept so the run can re-reveal a
    // surface the spotlight's own click dismissed, and close it again on exit.
    let revealedTrigger: HTMLElement | null = null;

    const closeRevealedSurface = () => {
      if (!revealedTrigger) {
        return;
      }
      revealedTrigger = null;
      // Escape is the disclosure-agnostic close: a menu or popover honours it,
      // and one that is already closed ignores it. driver.js ends a tour on
      // Escape *keyup*, so dispatching keydown alone cannot also end the run.
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    };

    // Resolves a step's anchor, re-opening the tour's surface first when the
    // anchor is missing because that surface closed: the spotlight popover
    // takes the pointer press that dismisses a menu, so an open menu does not
    // survive the user clicking "Next".
    const resolveStepElement = async (
      anchorId: GuideAnchorId,
    ): Promise<Element | null> => {
      const mounted = document.querySelector(guideAnchorSelector(anchorId));
      if (mounted) {
        return mounted;
      }
      revealedTrigger?.click();
      return await waitForAnchor(anchorId);
    };

    const applyInteraction = (
      interaction: GuideInteraction | undefined,
      element: Element,
    ) => {
      if (!interaction) {
        return;
      }
      switch (interaction.kind) {
        case "none":
          return;
        case "open":
          // Recorded, not clicked: `resolveStepElement` opens the surface when
          // the following step needs something inside it, so the user reads
          // this step against the closed control they are about to click.
          if (element instanceof HTMLElement) {
            revealedTrigger = element;
          }
          return;
        default:
          interaction satisfies never;
      }
    };

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
        const element = await resolveStepElement(step.anchor);
        if (!element) {
          // A menu that failed to open leaves the trigger recorded, so the next
          // step inside it can still try: one missing option never wedges the
          // rest of the tour.
          analytics.captureGuideStepSkipped({
            tourId: tour.id,
            anchorId: step.anchor,
            reason: "anchor-missing",
          });
          continue;
        }
        if (!element.closest(REVEALED_SURFACE_SELECTOR)) {
          // The tour has walked back out to the page behind the surface it
          // opened, so put the UI back the way the user left it.
          closeRevealedSurface();
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
            when:
              step.whenKey === undefined
                ? undefined
                : { label: t("guides.whenLabel"), text: t(step.whenKey) },
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
        applyInteraction(step.interaction, element);
      }
    } finally {
      // Covers every exit: completion, dismissal, and a step skipped because
      // its anchor never appeared. The tour never leaves UI it opened behind.
      closeRevealedSurface();
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
