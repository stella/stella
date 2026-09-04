import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Result } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { guideAnchorSelector } from "@/features/guides/guide-anchor";
import {
  type GuideAnchorId,
  PENDING_GUIDE_ANCHOR_IDS,
} from "@/features/guides/guide-anchors";
import type { GuideEngine } from "@/features/guides/guide-engine";
import { resolveGuideWorkspaceViewId } from "@/features/guides/guide-route";
import type {
  GuideSeed,
  GuideInteraction,
  GuideRoute,
  GuideStep,
  GuideTour,
  GuideTourId,
} from "@/features/guides/guide-types";
import { useMountEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { transformUnknownError } from "@/lib/errors/utils";
import { viewsOptions } from "@/lib/workspaces/queries/views";

// Bounded wait so a mid-load, flag-gated, or removed anchor never blocks the
// tour: after the timeout the step is skipped and the run moves on.
const STEP_POLL_TIMEOUT_MS = 10_000;
const STEP_POLL_INTERVAL_MS = 100;
const ROUTE_RENDER_TIMEOUT_MS = 45_000;

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
    // eslint-disable-next-line no-await-in-loop -- sequential by design: poll the DOM until the anchor mounts or the bounded deadline passes
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
  // The active matter, or the first authorized matter from the already-loaded
  // sidebar list. Matter tours resolve a matching view only when started.
  workspaceId: string | undefined;
};

export type GuideRunner = {
  runTour: (tour: GuideTour) => void;
  activeTourId: GuideTourId | null;
  isRunning: boolean;
};

export const useGuideRunner = ({
  onCompleted,
  workspaceId,
}: UseGuideRunnerOptions): GuideRunner => {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const t = useTranslations();
  const format = useFormatter();
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

  type NavigateAndWaitForRouteOptions = {
    pathname: string;
    signal: AbortSignal;
    startNavigation: () => Promise<void>;
  };

  const navigateAndWaitForRoute = async ({
    pathname,
    signal,
    startNavigation,
  }: NavigateAndWaitForRouteOptions): Promise<boolean> => {
    const renderedPathname =
      router.state.resolvedLocation?.pathname ?? router.state.location.pathname;
    if (renderedPathname === pathname) {
      await startNavigation();
      return !signal.aborted;
    }

    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const settle = (rendered: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        signal.removeEventListener("abort", handleAbort);
        resolve(rendered);
      };
      const handleAbort = () => settle(false);
      const unsubscribe = router.subscribe("onRendered", ({ toLocation }) => {
        settle(toLocation.pathname === pathname);
      });
      const timeout = setTimeout(() => {
        settle(false);
      }, ROUTE_RENDER_TIMEOUT_MS);
      signal.addEventListener("abort", handleAbort, { once: true });

      if (signal.aborted) {
        settle(false);
        return;
      }
      startNavigation().catch((error: unknown) => {
        if (settled) {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        signal.removeEventListener("abort", handleAbort);
        settled = true;
        reject(transformUnknownError(error));
      });
    });
  };

  const navigateToGuideRoute = async (
    route: GuideRoute,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await Result.tryPromise(async () => {
      switch (route.type) {
        case "static":
          return await navigateAndWaitForRoute({
            pathname: route.to,
            signal,
            startNavigation: async () => {
              await navigate({ to: route.to });
            },
          });
        case "workspace-unfiltered-table": {
          if (!workspaceId) {
            return false;
          }
          const views = await queryClient.query({
            ...viewsOptions(workspaceId),
            staleTime: "static",
          });
          const viewId = resolveGuideWorkspaceViewId(views);
          if (!viewId) {
            return false;
          }
          return await navigateAndWaitForRoute({
            pathname: `/workspaces/${workspaceId}/${viewId}`,
            signal,
            startNavigation: async () => {
              await navigate({
                to: "/workspaces/$workspaceId/$viewId",
                params: { workspaceId, viewId },
              });
            },
          });
        }
        default:
          route satisfies never;
          return false;
      }
    });
    if (Result.isError(result)) {
      analytics.captureError(result.error);
      return false;
    }
    return result.value;
  };

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

    type RevealingInteraction = Exclude<GuideInteraction, { kind: "none" }> & {
      anchor: GuideAnchorId;
    };

    // The interaction that reveals the surface a step at `index` lives in: the
    // nearest earlier step marked `open` or `transition`. Derived from the tour
    // on every resolve rather than remembered from the forward walk, so Back
    // can reconstruct a dismissed menu or local editor state.
    const revealingInteractionFor = (
      index: number,
    ): RevealingInteraction | undefined => {
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const candidate = tour.steps.at(earlier);
        if (candidate?.interaction && candidate.interaction.kind !== "none") {
          return { ...candidate.interaction, anchor: candidate.anchor };
        }
      }
      return undefined;
    };

    const activateAnchor = (anchorId: GuideAnchorId): boolean => {
      const trigger = document.querySelector(guideAnchorSelector(anchorId));
      if (!(trigger instanceof HTMLElement)) {
        return false;
      }
      trigger.click();
      return true;
    };

    // Presses a safe reveal control on the user's behalf. Transient disclosure
    // surfaces are tracked so they can be closed; local view transitions stay
    // in place until the user walks Back through their reversing control.
    const revealInteraction = (interaction: RevealingInteraction): boolean => {
      const revealed = activateAnchor(interaction.anchor);
      if (revealed && interaction.kind === "open") {
        surfaceOpen = true;
      }
      return revealed;
    };

    // Resolves a step's anchor, re-opening the surface it lives in first when
    // the anchor is missing because that surface closed: the spotlight popover
    // takes the pointer press that dismisses a menu, so an open menu does not
    // survive the user clicking a navigation button.
    const resolveStepElement = async (
      index: number,
      anchorId: GuideAnchorId,
      deadline: number,
      direction: GuideDirection,
    ): Promise<Element | null> => {
      if (isRunAborted()) {
        return null;
      }
      const mounted = document.querySelector(guideAnchorSelector(anchorId));
      if (mounted) {
        return mounted;
      }

      // A local transition unmounts its trigger. When walking backwards onto
      // that trigger, press the editor's real Back control first, then resolve
      // the trigger against the restored list.
      const targetStep = tour.steps.at(index);
      if (
        direction === -1 &&
        targetStep?.interaction?.kind === "transition" &&
        activateAnchor(targetStep.interaction.reverseAnchor)
      ) {
        return await waitForAnchor(anchorId, deadline, runAbort.signal);
      }

      const revealingInteraction = revealingInteractionFor(index);
      const revealed =
        revealingInteraction !== undefined &&
        revealInteraction(revealingInteraction);
      const element = await waitForAnchor(anchorId, deadline, runAbort.signal);
      if (!element && revealed) {
        // The reveal did not produce this anchor after all, so put the UI back
        // rather than leave a menu or empty editor open with no guide step.
        switch (revealingInteraction.kind) {
          case "open":
            closeRevealedSurface();
            break;
          case "transition":
            activateAnchor(revealingInteraction.reverseAnchor);
            break;
          default:
            revealingInteraction satisfies never;
        }
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
    let entryIndex = 0;

    const resolveFrom = async (
      from: number,
      direction: GuideDirection,
    ): Promise<ResolvedGuideStep | null> => {
      // Route rendering and anchor divergence have independent budgets. A
      // code-split route can legitimately show its pending component for
      // longer than an anchor should take to mount once that route commits.
      let deadline = Date.now() + STEP_POLL_TIMEOUT_MS;
      for (
        let index = from;
        index >= entryIndex && index < total;
        index += direction
      ) {
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
          // eslint-disable-next-line no-await-in-loop -- sequential by design: each candidate navigates then waits before the next is tried
          const routeAvailable = await navigateToGuideRoute(
            step.route,
            runAbort.signal,
          );
          if (isRunAborted()) {
            return null;
          }
          if (!routeAvailable) {
            analytics.captureGuideStepSkipped({
              reason: "route-unavailable",
              tourId: tour.id,
              anchorId: step.anchor,
            });
            continue;
          }
          // One navigation attempt gets one bounded DOM resolution budget.
          // Without a shared deadline, a diverged tour could spend the full
          // timeout on every remaining step and freeze for minutes.
          deadline = Date.now() + STEP_POLL_TIMEOUT_MS;
        }
        // eslint-disable-next-line no-await-in-loop -- sequential by design: resolve this candidate's anchor before trying the next
        const element = await resolveStepElement(
          index,
          step.anchor,
          deadline,
          direction,
        );
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
            current: format.number(index + 1),
            total: format.number(total),
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
      // A route-local editor can already be open on the tour's pathname. Start
      // at its earliest visible step instead of waiting for an unmounted list
      // anchor or implicitly discarding the user's unsaved work.
      const mountedStepIndex = tour.steps.findIndex((step) =>
        document.querySelector(guideAnchorSelector(step.anchor)),
      );
      const mountedStep =
        mountedStepIndex === -1 ? null : await resolveFrom(mountedStepIndex, 1);
      const first = mountedStep ?? (await resolveFrom(0, 1));
      if (!first) {
        return isRunAborted() ? { type: "cancelled" } : { type: "tour-empty" };
      }
      let current = first;
      // Steps before entry belong to the user's existing UI state. Back must
      // never cross this boundary and reverse an editor this run did not open.
      const firstIndex = first.index;
      entryIndex = firstIndex;

      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design: block on the user acting on this step before resolving the next
        const outcome = await showStep(engine, current, firstIndex);

        switch (outcome) {
          case "cancelled":
            return { type: "cancelled" };
          case "leave":
            return { type: "left" };
          case "back": {
            if (current.index <= firstIndex) {
              break;
            }
            // eslint-disable-next-line no-await-in-loop -- sequential by design: one step is resolved and shown at a time
            const previous = await resolveFrom(current.index - 1, -1);
            // Nothing earlier resolves: stay on this step rather than dropping
            // the user out of the tour on a back press. Re-resolving forwards
            // from the same index refreshes the element, which the backwards
            // probe may have navigated away from, and cannot re-enter the
            // backwards walk without another click.
            const restored =
              // eslint-disable-next-line no-await-in-loop -- sequential by design: one step is resolved and shown at a time
              previous ?? (await resolveFrom(current.index, 1));
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
            // eslint-disable-next-line no-await-in-loop -- sequential by design: one step is resolved and shown at a time
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
