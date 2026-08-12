import type * as React from "react";

import { hasTooltipContent } from "@stll/ui/lib/tooltip-content";

/**
 * How a button expresses "unavailable".
 *
 * `buttonVariants` carries `disabled:pointer-events-none`, and the browser
 * suppresses pointer and focus events on a natively disabled control anyway, so
 * a disabled button never receives hover or focus. A tooltip attached to it can
 * therefore never open, which is exactly when the user most needs to be told
 * why the action is unavailable. When there is a tooltip to show, the button
 * switches to the ARIA accessible-disabled pattern instead: it stays in the tab
 * order and keeps receiving pointer events, while every activation path is
 * blocked (see `blockDisabledActivation`).
 *
 * This mirrors Base UI's own `focusableWhenDisabled` disposition
 * (`useFocusableWhenDisabled`): `aria-disabled` instead of `disabled`, focusable,
 * and non-`Tab` key defaults suppressed.
 */
export const BUTTON_DISPOSITION = {
  enabled: "enabled",
  /** Native `disabled`: out of the tab order, inert to pointer and keyboard. */
  nativeDisabled: "native-disabled",
  /** `aria-disabled`: focusable and hoverable so its tooltip can still open. */
  accessibleDisabled: "accessible-disabled",
} as const;

export type ButtonDisposition =
  (typeof BUTTON_DISPOSITION)[keyof typeof BUTTON_DISPOSITION];

type ButtonDispositionInput = {
  disabled: boolean | undefined;
  loading: boolean | undefined;
  /** Resolved tooltip content, i.e. what `renderTooltipTrigger` would mount. */
  tooltip: React.ReactNode;
};

export const resolveButtonDisposition = ({
  disabled,
  loading,
  tooltip,
}: ButtonDispositionInput): ButtonDisposition => {
  if (disabled !== true && loading !== true) {
    return BUTTON_DISPOSITION.enabled;
  }
  return hasTooltipContent(tooltip)
    ? BUTTON_DISPOSITION.accessibleDisabled
    : BUTTON_DISPOSITION.nativeDisabled;
};

/**
 * The parts of a React synthetic event these blockers touch.
 *
 * `preventBaseUIHandler` is added by Base UI's `mergeProps` to the rightmost
 * handler in a merged chain; calling it stops the handlers merged to its left,
 * which is how a caller's own `onClick` is suppressed.
 */
type BlockableEvent = {
  preventDefault: () => void;
  preventBaseUIHandler?: (() => void) | undefined;
};

/**
 * Swallow an activation on an `aria-disabled` control.
 *
 * `preventDefault()` is what keeps a `type="submit"` button from submitting its
 * form: the browser's form-submission default runs off the click event, and
 * implicit submission (Enter in a text field) dispatches a click at the form's
 * default button, so both paths funnel through here.
 */
export const blockDisabledActivation = (event: BlockableEvent): void => {
  event.preventBaseUIHandler?.();
  event.preventDefault();
};

/**
 * The keyboard counterpart. `Tab` keeps its default so focus can leave the
 * control; suppressing the default on `Enter`/`Space` stops the browser from
 * synthesizing the click that would activate or submit.
 */
export const blockDisabledKeyActivation = (
  event: BlockableEvent & { key: string },
): void => {
  event.preventBaseUIHandler?.();
  if (event.key !== "Tab") {
    event.preventDefault();
  }
};
