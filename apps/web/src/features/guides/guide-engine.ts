import { type Driver, driver, type PopoverDOM } from "driver.js";
import "driver.js/dist/driver.css";

import "@/features/guides/guide-popover.css";

// Thin, swappable wrapper around the spotlight engine (driver.js, MIT, zero
// runtime deps). This module statically imports driver.js and its CSS; the
// runner loads it via dynamic `import()` so driver.js lands in its own async
// chunk and stays out of the initial route bundle.

const OVERLAY_OPACITY = 0.6;
const STAGE_PADDING_PX = 6;
const STAGE_RADIUS_PX = 8;

// The step's "when would I pick this?" line, already localized.
export type GuideEngineWhen = {
  label: string;
  text: string;
};

export type GuideEngineStep = {
  element: Element;
  title: string;
  body: string;
  // Rendered under the body as a muted, labelled secondary line; `undefined`
  // on steps that describe a control with no alternative to weigh it against.
  when: GuideEngineWhen | undefined;
  // Pre-localized "N of M" label; passed through verbatim (no {{tokens}}).
  progressText: string;
  // Back is rendered on every step and disabled here, so the footer keeps the
  // same shape from the first step to the last.
  isFirstStep: boolean;
  isLastStep: boolean;
  backLabel: string;
  nextLabel: string;
  doneLabel: string;
  leaveLabel: string;
  onBack: () => void;
  onNext: () => void;
  onLeave: () => void;
};

export type GuideEngine = {
  showStep: (step: GuideEngineStep) => void;
  destroy: () => void;
};

// driver.js assigns the popover description with `innerHTML`, which is the only
// seam for a second paragraph. Copy is compiled-in translation text, never user
// input, but escape it anyway so a future key containing `<` cannot become
// markup.
const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const buildDescription = ({ body, when }: GuideEngineStep): string => {
  const bodyHtml = `<p>${escapeHtml(body)}</p>`;
  if (!when) {
    return bodyHtml;
  }
  return `${bodyHtml}<p class="stella-guide-when"><span class="stella-guide-when-label">${escapeHtml(
    when.label,
  )}</span> ${escapeHtml(when.text)}</p>`;
};

// driver.js renders its close control as a bare "×" pinned to the popover's
// top corner, with no option to relabel or reposition it. Both are wrong for a
// control that ends the tour: it has to say what it does, and it has to sit
// with the other controls rather than lurk in a corner. Moving it to the end
// of the footer also puts it last in the popover's tab order, so driver's
// focus-the-first-tabbable-on-open lands on a navigation button and never on
// the one control that throws the run away.
const renderLeaveControl =
  (leaveLabel: string) =>
  ({ closeButton, footer }: PopoverDOM) => {
    closeButton.textContent = leaveLabel;
    // The visible label is now the accessible name; driver's hardcoded
    // "Close" aria-label would otherwise override it.
    closeButton.removeAttribute("aria-label");
    footer.append(closeButton);
  };

export const createGuideEngine = (): GuideEngine => {
  const instance: Driver = driver({
    // A stray click on the backdrop or a reflexive Escape must never cost the
    // user a half-finished tour. driver gates every teardown path it owns —
    // escape press, close click, overlay click — on this flag, so turning it
    // off makes the run un-losable by accident. The explicit, labelled leave
    // control in the footer is the single way out: it is wired through the
    // popover's own `onCloseClick` hook, which driver invokes directly instead
    // of through the flag-gated event, so it keeps working here.
    allowClose: false,
    // Stated rather than inherited: the backdrop stays inert on its own terms,
    // not as a side effect of `allowClose`.
    overlayClickBehavior: () => undefined,
    overlayOpacity: OVERLAY_OPACITY,
    stagePadding: STAGE_PADDING_PX,
    stageRadius: STAGE_RADIUS_PX,
    popoverClass: "stella-guide-popover",
  });

  return {
    showStep: (step) => {
      instance.highlight({
        element: step.element,
        popover: {
          title: step.title,
          description: buildDescription(step),
          showButtons: ["previous", "next", "close"],
          disableButtons: step.isFirstStep ? ["previous"] : [],
          showProgress: true,
          progressText: step.progressText,
          prevBtnText: step.backLabel,
          nextBtnText: step.isLastStep ? step.doneLabel : step.nextLabel,
          onPrevClick: () => step.onBack(),
          onNextClick: () => step.onNext(),
          onCloseClick: () => step.onLeave(),
          onPopoverRender: renderLeaveControl(step.leaveLabel),
          // No `side`/`align`: the popover is pinned to one fixed, centred
          // position by `guide-popover.css` rather than chasing the target
          // around the viewport, so per-step placement has nothing to say.
        },
      });
    },
    destroy: () => {
      instance.destroy();
    },
  };
};
