/**
 * Minimal replacement for `@radix-ui/react-slot`.
 *
 * Renders its single child element with the parent's props
 * (className, style, event handlers, ref, data-* attributes)
 * merged onto it. Used by sidebar components for the
 * `asChild` pattern.
 *
 * Ref composition logic adapted from the MIT-licensed
 * `@radix-ui/react-compose-refs` (v1.1.2).
 *
 * This module intentionally uses `Children.only` and
 * `cloneElement`: it is a low-level composition primitive
 * that merges props onto a single child, which is exactly
 * the use case React documents for these APIs.
 *
 * Several lint suppressions are necessary because prop
 * merging is inherently dynamic; the types of child props
 * are not statically known.
 */

import { Children, Fragment, cloneElement, isValidElement } from "react";

import { cn } from "@stll/ui/lib/utils";

type SlotProps = React.HTMLAttributes<HTMLElement> & {
  children?: React.ReactNode;
  ref?: React.Ref<HTMLElement> | undefined;
};

/**
 * Compose multiple refs into a single ref callback.
 * Adapted from `@radix-ui/react-compose-refs` (MIT).
 *
 * Collects cleanup functions returned by React 19 ref
 * callbacks and returns a combined cleanup so React can
 * invoke it on unmount instead of re-calling with `null`.
 */
export const composeRefs =
  <T,>(
    ...refs: (React.Ref<T> | undefined)[]
  ): ((node: T | null) => (() => void) | undefined) =>
  (node) => {
    const cleanups: (() => void)[] = [];
    for (const ref of refs) {
      if (typeof ref === "function") {
        const cleanup = ref(node);
        if (typeof cleanup === "function") {
          cleanups.push(() => {
            void cleanup();
          });
        } else if (node !== null) {
          cleanups.push(() => {
            void ref(null);
          });
        }
      } else if (ref !== undefined && ref !== null) {
        ref.current = node;
        if (node !== null) {
          cleanups.push(() => {
            ref.current = null;
          });
        }
      }
    }
    if (cleanups.length > 0) {
      return () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };
    }
    return undefined;
  };

const Slot = ({
  ref: parentRef,
  children,
  className,
  style,
  ...rest
}: SlotProps): React.ReactNode => {
  const child = Children.only(children);

  if (!isValidElement<Record<string, unknown>>(child)) {
    return child;
  }

  // Fragments cannot hold refs; render as-is without
  // attempting ref composition or prop merging.
  if (child.type === Fragment) {
    return child;
  }

  const childProps = child.props;
  // Spread parent props first, then child props, so child-
  // provided data-*, aria-*, id, role, etc. take precedence
  // (matching Radix Slot behaviour). Explicitly merged keys
  // (ref, className, style, event handlers) are overwritten
  // below.
  const mergedProps: Record<string, unknown> = {
    ...rest,
    ...childProps,
  };

  // Compose refs so neither parent nor child ref is dropped.
  // In React 19, ref lives in element.props (element.ref is
  // deprecated and triggers console warnings in dev).
  const childRef = childProps["ref"];
  if (parentRef !== undefined || childRef !== undefined) {
    mergedProps["ref"] = composeSlotRefs(parentRef, childRef);
  }

  // Merge className via cn()
  const childClassName = childProps["className"];
  if (className || typeof childClassName === "string") {
    mergedProps["className"] = cn(
      className,
      typeof childClassName === "string" ? childClassName : undefined,
    );
  }

  // Merge style objects
  const childStyle = childProps["style"];
  if (style || (typeof childStyle === "object" && childStyle !== null)) {
    mergedProps["style"] = {
      ...style,
      ...(typeof childStyle === "object" && childStyle !== null
        ? childStyle
        : {}),
    };
  }

  // Merge event handlers: child runs first, then parent.
  // This matches Radix's Slot behaviour: because handlers
  // are merged (not DOM-propagated), the child can inspect
  // the event before the parent acts on it.
  const restEntries: [string, unknown][] = Object.entries(rest);
  for (const [key, parentValue] of restEntries) {
    if (key.startsWith("on") && typeof parentValue === "function") {
      const childValue = childProps[key];

      if (typeof childValue === "function") {
        mergedProps[key] = (...args: unknown[]) => {
          Reflect.apply(childValue, undefined, args);
          Reflect.apply(parentValue, undefined, args);
        };
      }
    }
  }

  return cloneElement(child, mergedProps);
};

const composeSlotRefs =
  (parentRef: React.Ref<HTMLElement> | undefined, childRef: unknown) =>
  (node: HTMLElement | null) => {
    setSlotRef(parentRef, node);
    setSlotRef(childRef, node);
  };

const setSlotRef = (ref: unknown, node: HTMLElement | null): void => {
  if (typeof ref === "function") {
    Reflect.apply(ref, undefined, [node]);
    return;
  }
  if (typeof ref === "object" && ref !== null && "current" in ref) {
    ref.current = node;
  }
};

export { Slot };
