import { useRef, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { guideAnchorSelector } from "@/features/guides/guide-anchor";
import {
  type GuideAnchorId,
  PENDING_GUIDE_ANCHOR_IDS,
} from "@/features/guides/guide-anchors";
import type { GuideEngine } from "@/features/guides/guide-engine";
import type {
  GuideSeed,
  GuideStep,
  GuideTour,
  GuideTourId,
} from "@/features/guides/guide-types";
import { useMountEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";

// Bounded wait so a mid-load, flag-gated, or removed anchor never blocks the
// tour: after the timeout the step is skipped and the run moves on.
const STEP_POLL_TIMEOUT_MS = 2000;
const STEP_POLL_INTERVAL_MS = 100;

// Anchors the registry already declares unwired. Waiting the full deadline on
// each of these would make a not-yet-wired tour sit on a frozen popover for
// seconds before giving up, so they are skipped without navigating or polling
// and the deadline is spent only on anchors that are supposed to be there.
const isPendingAnchor = (anchorId: GuideAnchorId): boolean =>
  PENDING_GUIDE_ANCHOR_IDS.includes(anchorId);

const delay = async (ms: number, signal: AbortSignal): Promise<boolean> =>
  await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (elapsedNormally: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      resolve(elapsedNormally);
    };
    const handleAbort = () => {
      clearTimeout(timeout);
      settle(false);
    };
    const timeout = setTimeout(() => {
      settle(true);
    }, ms);
    signal.addEventListener("abort", handleAbort, { once: true });
  });

const waitForAnchor = async (
  anchorId: GuideAnchorId,
  deadline: number,
  signal: AbortSignal,
): Promise<Element | null> => {
  const selector = guideAnchorSelector(anchorId);
  for (;;) {
    if (signal.aborted) {
      return null;
    }
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    const elapsedNormally = await delay(STEP_POLL_INTERVAL_MS, signal);
    if (!elapsedNormally) {
      return null;
    }
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

// Which way the run is walking the tour. A walk only ever moves one way until
// the user clicks again; see `resolveFrom`.
type GuideDirection = 1 | -1;

// A step whose anchor resolved against the live DOM, ready to be shown.
type ResolvedGuideStep = {
  index: number;
  step: GuideStep;
  element: Element;
};

// What the user did with the popover.
type GuideStepOutcome = "next" | "back" | "leave" | "cancelled";

// How the run ended. Only `completed` marks the tour done.
type GuideRunExit =
  | { type: "completed" }
  | { type: "left" }
  | { type: "cancelled" }
  // Not one step resolved against the live surface: the tour has diverged
  // from the app entirely.
  | { type: "tour-empty" }
  // Steps were shown, then the run ran out of resolvable ones. Distinct from
  // completion, which is reaching the end going forwards.
  | { type: "exhausted" };

type UseGuideRunnerOptions = {
  // Invoked once a tour reaches its final step (not when the user leaves).
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
  const runAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // Set synchronously in `runTour`, before its first await. The engine handle
  // only exists once the dynamic import resolves, so guarding on that instead
  // would let a second start slip through the import window and stack two
  // overlays over the app.
  const runActiveRef = useRef(false);

  useMountEffect(() => {
    mountedRef.current = true;
    return () => {
      // A run can be awaiting the engine chunk, an anchor, or a popover click
      // when its owner unmounts. Abort every await and remove any live overlay.
      mountedRef.current = false;
      runAbortRef.current?.abort();
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  });

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
        // target is a no-op, so a demo seed can never throw and re-applying it
        // when the user steps back onto the same step is idempotent.
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
        panic(`Unhandled seed: ${String(seed)}`);
    }
  };

  const runTour = async (tour: GuideTour) => {
    if (runActiveRef.current) {
      return;
    }
    runActiveRef.current = true;
    const runAbort = new AbortController();
    runAbortRef.current = runAbort;
    const isRunAborted = () => runAbort.signal.aborted;
    setState({ status: "running", tourId: tour.id });

    const total = tour.steps.length;
    // Whether this run currently has a disclosure surface open. Only tracks
    // open/closed: which trigger to press is derived from the tour itself, so
    // it cannot go stale as the run walks in either direction.
    let surfaceOpen = false;

    const closeRevealedSurface = () => {
      if (!surfaceOpen) {
        return;
      }
      surfaceOpen = false;
      // Escape is the disclosure-agnostic close: a menu or popover honours it,
      // and one that is already closed ignores it. Dispatching from the body
      // does not hit the guide's focused-popover Escape handler.
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    };

    // The trigger that reveals the surface a step at `index` lives in: the
    // nearest earlier step marked `interaction: { kind: "open" }`. Derived from
    // the tour on every resolve rather than remembered from the forward walk,
    // so walking *back* into a menu re-opens it instead of spending the anchor
    // deadline once per option it can no longer see.
    const revealingAnchorFor = (index: number): GuideAnchorId | undefined => {
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const candidate = tour.steps.at(earlier);
        if (candidate?.interaction?.kind === "open") {
          return candidate.anchor;
        }
      }
      return undefined;
    };

    // Presses a disclosure trigger on the user's behalf. Safe by the contract
    // on `GuideInteraction`: `open` may only ever mark a control whose click
    // does nothing but show UI.
    const revealSurface = (anchorId: GuideAnchorId): boolean => {
      const trigger = document.querySelector(guideAnchorSelector(anchorId));
      if (!(trigger instanceof HTMLElement)) {
        return false;
      }
      trigger.click();
      surfaceOpen = true;
      return true;
    };

    // Resolves a step's anchor, re-opening the surface it lives in first when
    // the anchor is missing because that surface closed: the spotlight popover
    // takes the pointer press that dismisses a menu, so an open menu does not
    // survive the user clicking a navigation button.
    const resolveStepElement = async (
      index: number,
      anchorId: GuideAnchorId,
      deadline: number,
    ): Promise<Element | null> => {
      if (isRunAborted()) {
        return null;
      }
      const mounted = document.querySelector(guideAnchorSelector(anchorId));
      if (mounted) {
        return mounted;
      }
      const revealingAnchor = revealingAnchorFor(index);
      const revealed =
        revealingAnchor !== undefined && revealSurface(revealingAnchor);
      const element = await waitForAnchor(anchorId, deadline, runAbort.signal);
      if (!element && revealed) {
        // The reveal did not produce this anchor after all, so put the surface
        // back rather than leave a menu open that no step is explaining.
        closeRevealedSurface();
      }
      return element;
    };

    // Walks from `from` in `direction` until a step's anchor resolves against
    // the live DOM. Forwards and backwards resolve a step identically:
    // navigate to its route, re-open the surface the step lives in if the
    // anchor is not on the page, then poll for the anchor within the bounded
    // deadline. A step whose anchor never appears is logged and skipped, never
    // thrown, so one diverged step cannot wedge the run in either direction.
    //
    // The walk itself never reverses: it returns a step on the `direction`
    // side of `from`, or runs off that end and returns null. Since only a user
    // click starts a new walk, and each walk moves the run strictly one way,
    // two unresolvable steps can never bounce the run back and forth between
    // them.
    const resolveFrom = async (
      from: number,
      direction: GuideDirection,
    ): Promise<ResolvedGuideStep | null> => {
      // One navigation attempt gets one bounded resolution budget. Without a
      // shared deadline, a diverged tour could spend the full timeout on every
      // remaining step and hold the user in a frozen run for minutes.
      const deadline = Date.now() + STEP_POLL_TIMEOUT_MS;
      for (let index = from; index >= 0 && index < total; index += direction) {
        if (isRunAborted() || Date.now() >= deadline) {
          return null;
        }
        const step = tour.steps.at(index);
        if (!step) {
          continue;
        }
        if (isPendingAnchor(step.anchor)) {
          // Declared unwired in the registry: skipping it costs nothing, so
          // there is no reason to navigate to its route or wait on its anchor.
          analytics.captureGuideStepSkipped({
            reason: "anchor-pending",
            tourId: tour.id,
            anchorId: step.anchor,
          });
          continue;
        }
        if (step.route) {
          await navigate({ to: step.route });
          if (isRunAborted()) {
            return null;
          }
        }
        const element = await resolveStepElement(index, step.anchor, deadline);
        if (isRunAborted()) {
          return null;
        }
        if (!element) {
          analytics.captureGuideStepSkipped({
            reason: "anchor-missing",
            tourId: tour.id,
            anchorId: step.anchor,
          });
          continue;
        }
        return { index, step, element };
      }
      return null;
    };

    const showStep = async (
      engine: GuideEngine,
      { index, step, element }: ResolvedGuideStep,
      firstIndex: number,
    ): Promise<GuideStepOutcome> => {
      if (!element.closest(REVEALED_SURFACE_SELECTOR)) {
        // The tour has walked back out to the page behind the surface it
        // opened — forwards past it, or backwards onto the control that opens
        // it — so put the UI back the way the user left it.
        closeRevealedSurface();
      }
      applySeed(step.seed);

      return await new Promise<GuideStepOutcome>((resolve) => {
        let settled = false;
        const settle = (outcome: GuideStepOutcome) => {
          if (settled) {
            return;
          }
          settled = true;
          runAbort.signal.removeEventListener("abort", handleAbort);
          resolve(outcome);
        };
        const handleAbort = () => settle("cancelled");
        runAbort.signal.addEventListener("abort", handleAbort, { once: true });
        if (isRunAborted()) {
          settle("cancelled");
          return;
        }
        engine.showStep({
          element,
          title: t(step.titleKey),
          body: t(step.bodyKey),
          when:
            step.whenKey === undefined
              ? undefined
              : { label: t("guides.whenLabel"), text: t(step.whenKey) },
          // Numbered by position in the tour, so the count reads the same
          // whichever direction the user arrived from.
          progressText: t("common.stepProgress", {
            current: String(index + 1),
            total: String(total),
          }),
          // Everything before the earliest step this run could resolve has
          // already been probed and skipped, so back is genuinely dead there
          // and the control says so instead of doing nothing.
          isFirstStep: index <= firstIndex,
          isLastStep: index === total - 1,
          backLabel: t("common.back"),
          nextLabel: t("common.next"),
          doneLabel: t("common.done"),
          leaveLabel: t("guides.leave"),
          onBack: () => settle("back"),
          onNext: () => settle("next"),
          onLeave: () => settle("leave"),
        });
      });
    };

    const drive = async (engine: GuideEngine): Promise<GuideRunExit> => {
      const first = await resolveFrom(0, 1);
      if (!first) {
        return isRunAborted() ? { type: "cancelled" } : { type: "tour-empty" };
      }
      let current = first;
      // The earliest step this run has shown. Tracked so the back control is
      // disabled where there is provably nothing behind it.
      let firstIndex = first.index;

      for (;;) {
        firstIndex = Math.min(firstIndex, current.index);
        const outcome = await showStep(engine, current, firstIndex);

        switch (outcome) {
          case "cancelled":
            return { type: "cancelled" };
          case "leave":
            return { type: "left" };
          case "back": {
            const previous = await resolveFrom(current.index - 1, -1);
            // Nothing earlier resolves: stay on this step rather than dropping
            // the user out of the tour on a back press. Re-resolving forwards
            // from the same index refreshes the element, which the backwards
            // probe may have navigated away from, and cannot re-enter the
            // backwards walk without another click.
            const restored = previous ?? (await resolveFrom(current.index, 1));
            if (!restored) {
              return isRunAborted()
                ? { type: "cancelled" }
                : { type: "exhausted" };
            }
            current = restored;
            break;
          }
          case "next": {
            if (current.index === total - 1) {
              return { type: "completed" };
            }
            const next = await resolveFrom(current.index + 1, 1);
            if (!next) {
              return isRunAborted()
                ? { type: "cancelled" }
                : { type: "exhausted" };
            }
            current = next;
            break;
          }
          default:
            outcome satisfies never;
            panic(`Unhandled outcome: ${String(outcome)}`);
        }
      }
    };

    const reportExit = (exit: GuideRunExit) => {
      switch (exit.type) {
        case "cancelled":
        case "left":
          return;
        case "tour-empty": {
          // Every step diverged from the live surface: end cleanly, surface it.
          analytics.captureGuideStepSkipped({
            reason: "tour-empty",
            tourId: tour.id,
          });
          stellaToast.add({ title: t("guides.unavailable"), type: "info" });
          return;
        }
        case "exhausted":
          // The surface moved under a run that had already started. Say so
          // rather than ending silently, and do not mark the tour done.
          stellaToast.add({ title: t("guides.unavailable"), type: "info" });
          return;
        case "completed":
          onCompleted(tour.id);
          return;
        default:
          exit satisfies never;
          panic(`Unhandled exit: ${String(exit)}`);
      }
    };

    try {
      const { createGuideEngine } =
        await import("@/features/guides/guide-engine");
      if (isRunAborted()) {
        return;
      }
      const engine = createGuideEngine();
      engineRef.current = engine;

      let exit: GuideRunExit;
      try {
        exit = await drive(engine);
      } finally {
        // Covers every exit: completion, leaving, and a run where no step could
        // be resolved. The tour never leaves UI it opened behind.
        closeRevealedSurface();
        engine.destroy();
        engineRef.current = null;
      }
      reportExit(exit);
    } finally {
      // Also covers a failed engine import, which would otherwise leave the
      // checklist disabled with no way back.
      runActiveRef.current = false;
      if (runAbortRef.current === runAbort) {
        runAbortRef.current = null;
      }
      if (mountedRef.current) {
        setState({ status: "idle" });
      }
    }
  };

  const start = (tour: GuideTour) => {
    detached(runTour(tour), "use-guide-runner.run-tour");
  };

  return {
    runTour: start,
    activeTourId: state.status === "running" ? state.tourId : null,
    isRunning: state.status === "running",
  };
};
