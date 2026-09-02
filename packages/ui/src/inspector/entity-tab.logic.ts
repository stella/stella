/**
 * Pure activation/close-gesture policy for `InspectorEntityTab`, kept out
 * of the component so it's unit-testable without a DOM: each function
 * takes only the plain values a `MouseEvent` carries (or the host's
 * optional callbacks), never the event object itself.
 */

/** The `MouseEvent.button` value for a middle-click (the wheel / auxiliary
 * button) — the browser convention `onAuxClick` reports it under. */
const MIDDLE_CLICK_BUTTON = 1;

/** Whether a mouse button number is the tab's "close" gesture
 * (middle-click). */
export const isEntityTabCloseGesture = (button: number): boolean =>
  button === MIDDLE_CLICK_BUTTON;

/**
 * Resolves what an `onAuxClick` with this `button` should do: close the
 * tab (the given `onClose`) when the gesture matches and the host
 * supplied one, or nothing (`undefined`) otherwise. Returning `undefined`
 * for "do nothing" (rather than a boolean) lets the component skip
 * `preventDefault()` too when there's truly nothing to do, leaving the
 * browser's own middle-click behavior alone.
 */
export const resolveEntityTabCloseHandler = (
  button: number,
  onClose: (() => void) | undefined,
): (() => void) | undefined =>
  isEntityTabCloseGesture(button) ? onClose : undefined;

/**
 * Resolves the tab's click/activation handler: `onSelect` when the host
 * supplied one, a stable no-op otherwise, so the component always has a
 * callable handler to hand to `containedEventHandler` regardless of
 * whether the host cares about selection.
 */
export const resolveEntityTabActivateHandler = (
  onSelect: (() => void) | undefined,
): (() => void) => onSelect ?? entityTabNoop;

const entityTabNoop = () => undefined;
