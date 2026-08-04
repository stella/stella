import { type Driver, driver } from "driver.js";
import "driver.js/dist/driver.css";

import type { GuidePlacement } from "@/features/guides/guide-types";

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
  placement?: GuidePlacement | undefined;
  // Pre-localized "N of M" label; passed through verbatim (no {{tokens}}).
  progressText: string;
  isLastStep: boolean;
  nextLabel: string;
  doneLabel: string;
  onNext: () => void;
};

export type GuideEngine = {
  showStep: (step: GuideEngineStep) => void;
  destroy: () => void;
};

// driver.js assigns the popover description with `innerHTML`, which is the only
// seam for a second paragraph. Copy is compiled-in translation text, never user
// input, but escape it anyway so a future key containing `<` cannot become
// markup. Styling is inline: the popover is appended to `document.body` outside
// the app tree, so it is reached by design tokens on `:root` but not by the
// utility classes the app's own components use.
const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const WHEN_PARAGRAPH_STYLE =
  "margin-top:0.5rem;color:var(--color-muted-foreground);font-size:0.8125rem;line-height:1.45";

const buildDescription = ({ body, when }: GuideEngineStep): string => {
  const bodyHtml = `<p>${escapeHtml(body)}</p>`;
  if (!when) {
    return bodyHtml;
  }
  return `${bodyHtml}<p style="${WHEN_PARAGRAPH_STYLE}"><span style="font-weight:600">${escapeHtml(
    when.label,
  )}</span> ${escapeHtml(when.text)}</p>`;
};

type CreateGuideEngineOptions = {
  // Invoked when the user dismisses the tour (close button, overlay click, or
  // Escape) rather than advancing to the end.
  onDismiss: () => void;
};

export const createGuideEngine = ({
  onDismiss,
}: CreateGuideEngineOptions): GuideEngine => {
  // Distinguishes a programmatic teardown (advance/finish/unmount) from a
  // user-initiated dismiss so `onDismiss` fires only for the latter.
  let teardownRequested = false;

  const instance: Driver = driver({
    allowClose: true,
    overlayClickBehavior: "close",
    overlayOpacity: OVERLAY_OPACITY,
    stagePadding: STAGE_PADDING_PX,
    stageRadius: STAGE_RADIUS_PX,
    popoverClass: "stella-guide-popover",
    onDestroyStarted: () => {
      if (!teardownRequested) {
        teardownRequested = true;
        onDismiss();
      }
      instance.destroy();
    },
  });

  return {
    showStep: (step) => {
      instance.highlight({
        element: step.element,
        popover: {
          title: step.title,
          description: buildDescription(step),
          align: "start",
          showButtons: ["next", "close"],
          showProgress: true,
          progressText: step.progressText,
          nextBtnText: step.isLastStep ? step.doneLabel : step.nextLabel,
          onNextClick: () => step.onNext(),
          // Omit `side` when unset so driver auto-places (exactOptionalPropertyTypes
          // forbids passing an explicit `undefined`).
          ...(step.placement === undefined ? {} : { side: step.placement }),
        },
      });
    },
    destroy: () => {
      teardownRequested = true;
      instance.destroy();
    },
  };
};
