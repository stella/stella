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

/* eslint-disable eslint-plugin-react/no-react-children */
/* eslint-disable eslint-plugin-react/no-clone-element */
/* eslint-disable typescript-eslint/no-unsafe-type-assertion */
/* eslint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */

import { Children, Fragment, cloneElement, isValidElement } from "react";

import { cn } from "@stella/ui/lib/utils";

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
const composeRefs =
  <T,>(
    ...refs: (React.Ref<T> | undefined)[]
  ): ((node: T | null) => (() => void) | undefined) =>
  (node) => {
    const cleanups: (() => void)[] = [];
    for (const ref of refs) {
      if (typeof ref === "function") {
        const cleanup = ref(node);
        if (typeof cleanup === "function") {
          cleanups.push(cleanup);
        }
      } else if (ref !== undefined && ref !== null) {
        ref.current = node;
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

  if (!isValidElement(child)) {
    return child;
  }

  // Fragments cannot hold refs; render as-is without
  // attempting ref composition or prop merging.
  if (child.type === Fragment) {
    return child;
  }

  // SAFETY: React element props are always a plain object
  // at runtime; the generic type is erased.
  const childProps = child.props as Record<string, unknown>;
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
  // SAFETY: childProps is typed as Record<string, unknown>;
  // React guarantees ref is either a Ref or undefined.
  const childRef = childProps.ref as React.Ref<unknown> | undefined;
  if (parentRef || childRef) {
    mergedProps.ref = composeRefs(parentRef, childRef);
  }

  // Merge className via cn()
  const childClassName = childProps.className;
  if (className || typeof childClassName === "string") {
    // SAFETY: guarded by the typeof check above.
    mergedProps.className = cn(className, childClassName as string);
  }

  // Merge style objects
  const childStyle = childProps.style;
  if (style || (typeof childStyle === "object" && childStyle !== null)) {
    mergedProps.style = {
      ...style,
      // SAFETY: guarded by the typeof === "object" check
      // above; CSSProperties is the only object-typed
      // style value React accepts.
      ...(childStyle as React.CSSProperties | undefined),
    };
  }

  // Merge event handlers: child runs first, then parent.
  // This matches Radix's Slot behaviour: because handlers
  // are merged (not DOM-propagated), the child can inspect
  // the event before the parent acts on it.
  // SAFETY: rest is typed as React.HTMLAttributes<HTMLElement>
  // which is structurally a plain object at runtime.
  const restRecord = rest as Record<string, unknown>;
  for (const key of Object.keys(restRecord)) {
    const parentValue: unknown = restRecord[key];
    if (key.startsWith("on") && typeof parentValue === "function") {
      // SAFETY: narrowed by typeof === "function" above.
      const parentHandler = parentValue as (...args: unknown[]) => void;
      const childValue = childProps[key];

      if (typeof childValue === "function") {
        // SAFETY: narrowed by typeof === "function" above.
        const childHandler = childValue as (...args: unknown[]) => void;
        mergedProps[key] = (...args: unknown[]) => {
          childHandler(...args);
          parentHandler(...args);
        };
      }
    }
  }

  return cloneElement(child, mergedProps);
};

export { Slot };
