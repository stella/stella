import type * as React from "react";

/**
 * Wrap a React event handler so it only fires when the event target
 * is a DOM descendant of the given ref.
 *
 * React forwards synthetic events through the parent React tree even
 * when descendants are rendered via createPortal. That makes it unsafe
 * for a parent element to attach `onMouseDown`, `onClick`, `onFocus`,
 * etc. that side-effect (focus steal, preventDefault, selection changes,
 * blur restoration) under the assumption "the target lives inside me" —
 * a portaled popup (Dialog, Combobox, Tooltip) silently bypasses the
 * DOM boundary and triggers the side effect, dismissing itself.
 *
 * The `require-contained-handler` oxlint rule enforces this whenever a
 * JSX element carries both `ref={…}` and an event-handler prop in the
 * watched set (`onMouseDown`, `onMouseUp`, `onClick`, `onPointerDown`,
 * `onPointerUp`, `onFocus`, `onBlur`).
 *
 * @example
 *   const barRef = useRef<HTMLDivElement>(null);
 *   return (
 *     <div
 *       ref={barRef}
 *       onMouseDown={containedHandler(barRef, (e) => {
 *         e.preventDefault();
 *         focusEditor();
 *       })}
 *     >
 *       ...
 *     </div>
 *   );
 */
export const containedHandler =
  <E extends { target: EventTarget | null }>(
    ref: React.RefObject<HTMLElement | null> | null | undefined,
    handler: ((event: E) => void) | undefined,
  ) =>
  (event: E): void => {
    if (handler === undefined) {
      return;
    }
    const container = ref?.current ?? null;
    if (
      container !== null &&
      event.target instanceof Element &&
      !container.contains(event.target)
    ) {
      return;
    }
    handler(event);
  };
