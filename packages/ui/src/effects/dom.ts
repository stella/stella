// The sanctioned way to keep React state from the DOM: a value observed on
// an element (a measurement, an intersection, a size) or derived from a
// blob. Together with ./effects.ts this is the only code that writes state
// from an effect (no-effect-state-write exempts the directory by
// ownership); callers only receive values.
//
// Loop-free by construction: values are scalars or flat records of scalars,
// so the equality guard can always tell an unchanged value, and an unchanged
// value returns the same state object, on which React bails out. The one
// loop construction cannot exclude is real layout feedback (the render a
// value causes changes the measurement back); the oscillation breaker stops
// admitting a strict two-value alternation and reports it once (`reportError`).
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { DependencyList } from "react";

import { useLatest } from "./effects";

type Scalar = string | number | boolean | null | undefined;

/** A value the equality guard can always compare: a scalar or a flat record of scalars. */
export type Flat = Scalar | Readonly<Record<string, Scalar>>;

const isRecord = (value: Flat): value is Readonly<Record<string, Scalar>> =>
  typeof value === "object" && value !== null;

/** Equal scalars, or flat records with the same keys and equal values. */
export const flatEqual = (left: Flat, right: Flat): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]),
    )
  );
};

/** Consecutive alternating emits that count as layout feedback. */
const OSCILLATION_EMITS = 8;
/** The window those emits must fall inside. */
const OSCILLATION_WINDOW_MS = 400;

type OscillationBreaker = { admit: (value: Flat) => boolean };

// Admits values until the last OSCILLATION_EMITS of them alternate between
// two values (A, B, A, B, ...) inside OSCILLATION_WINDOW_MS, then holds:
// a dragged splitter produces new values, not a strict alternation.
export const createOscillationBreaker = (
  now: () => number = () => performance.now(),
): OscillationBreaker => {
  const recent: { value: Flat; at: number }[] = [];
  let latched = false;
  return {
    admit: (value) => {
      if (latched) {
        return false;
      }
      recent.push({ value, at: now() });
      if (recent.length > OSCILLATION_EMITS) {
        recent.shift();
      }
      const first = recent.at(0);
      const last = recent.at(-1);
      const alternates =
        recent.length === OSCILLATION_EMITS &&
        first !== undefined &&
        last !== undefined &&
        last.at - first.at <= OSCILLATION_WINDOW_MS &&
        recent.every(
          (entry, index) =>
            index < 2 ||
            (flatEqual(entry.value, recent[index - 2]?.value) &&
              !flatEqual(entry.value, recent[index - 1]?.value)),
        );
      if (alternates) {
        latched = true;
        globalThis.reportError(
          new Error(
            "[layout-oscillation] an observed value kept alternating between two values; holding the current one. The render it causes changes the measurement back: break the feedback (reserve the space, or measure an element the value does not resize).",
          ),
        );
        return false;
      }
      return true;
    },
  };
};

/**
 * Runs `observe(element, emit)` while `element` is non-null (from a layout
 * effect, so a synchronous first emit lands before paint) and returns the
 * last emitted value, or `fallback` while there is no element or nothing
 * has been emitted for it. Pass the element held in state
 * (`const [el, setEl] = useState<HTMLElement | null>(null)`, `ref={setEl}`)
 * so a node that mounts later is observed too.
 *
 * `observe` is read at subscription time; it re-subscribes when `element`
 * or `deps` change, never because `observe` is a new function.
 */
export const useObservedValue = <E extends Element, T extends Flat>(
  element: E | null,
  observe: (element: E, emit: (value: T) => void) => () => void,
  deps: DependencyList,
  fallback: T,
): T => {
  const [slot, setSlot] = useState<{ element: E | null; value: T }>({
    element: null,
    value: fallback,
  });
  const latestObserve = useLatest(observe);
  useLayoutEffect(() => {
    if (element === null) {
      return undefined;
    }
    const breaker = createOscillationBreaker();
    // The subscription drops a value equal to the last one it admitted and
    // runs the breaker once per real change, outside React's updater (which
    // StrictMode may call twice); the updater stays pure.
    let admitted: { readonly value: T } | null = null;
    return latestObserve.current(element, (next) => {
      if (admitted !== null && flatEqual(admitted.value, next)) {
        return;
      }
      if (!breaker.admit(next)) {
        return;
      }
      admitted = { value: next };
      setSlot((current) =>
        current.element === element && flatEqual(current.value, next)
          ? current
          : { element, value: next },
      );
    });
  }, [element, ...deps]);
  // A slot from another element is ignored, never reset by a write.
  return slot.element === element && element !== null ? slot.value : fallback;
};

/**
 * `measure(element)` before the first paint and again whenever the element
 * resizes. `measure` must only read the DOM. Round fractional pixels when
 * sub-pixel jitter is not meaningful to the caller. Resizes are those of the
 * content box; `useElementSize` follows the border box.
 */
export const useLayoutMeasurement = <E extends Element, T extends Flat>(
  element: E | null,
  measure: (element: E) => T,
  deps: DependencyList,
  fallback: T,
): T => {
  const latestMeasure = useLatest(measure);
  return useObservedValue(
    element,
    (observed, emit) => {
      emit(latestMeasure.current(observed));
      if (typeof ResizeObserver === "undefined") {
        return () => undefined;
      }
      const observer = new ResizeObserver(() => {
        emit(latestMeasure.current(observed));
      });
      observer.observe(observed);
      return () => {
        observer.disconnect();
      };
    },
    deps,
    fallback,
  );
};

type ElementSize = { readonly width: number; readonly height: number };

/** The element's rendered size in CSS pixels, or `null` without an element. */
export const useElementSize = (element: Element | null): ElementSize | null =>
  useObservedValue<Element, ElementSize | null>(
    element,
    (observed, emit) => {
      const measure = () => {
        const { width, height } = observed.getBoundingClientRect();
        emit({ width, height });
      };
      measure();
      if (typeof ResizeObserver === "undefined") {
        return () => undefined;
      }
      // The bounding rectangle is the border box: padding and border
      // changes resize it without resizing the content box.
      const observer = new ResizeObserver(measure);
      observer.observe(observed, { box: "border-box" });
      return () => {
        observer.disconnect();
      };
    },
    [],
    null,
  );

type IntersectingOptions = {
  readonly root?: Element | null;
  readonly rootMargin?: string;
  readonly threshold?: number;
  /** Stop observing once the element has intersected. */
  readonly once?: boolean;
};

/**
 * Whether the element intersects its root. Without IntersectionObserver
 * every element counts as intersecting.
 */
export const useIntersecting = (
  element: Element | null,
  {
    root = null,
    rootMargin,
    threshold,
    once = false,
  }: IntersectingOptions = {},
): boolean =>
  useObservedValue<Element, boolean>(
    element,
    (observed, emit) => {
      if (typeof IntersectionObserver === "undefined") {
        emit(true);
        return () => undefined;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          // One delivery can hold several crossings: live observation follows
          // the latest; `once` only needs to know the element got in at all.
          const intersecting = once
            ? entries.some((entry) => entry.isIntersecting)
            : (entries.at(-1)?.isIntersecting ?? false);
          emit(intersecting);
          if (intersecting && once) {
            observer.disconnect();
          }
        },
        {
          root,
          ...(rootMargin === undefined ? {} : { rootMargin }),
          ...(threshold === undefined ? {} : { threshold }),
        },
      );
      observer.observe(observed);
      return () => {
        observer.disconnect();
      };
    },
    [root, rootMargin, threshold, once],
    false,
  );

// Object URLs, shared and reference-counted by blob: one URL per blob for as
// long as any component shows it, revoked a microtask after the last one
// lets go (a StrictMode unmount and remount in the same commit keeps it).
type ObjectUrlEntry = {
  readonly url: string;
  readonly revoke: () => void;
  holders: number;
};
const objectUrls = new WeakMap<Blob, ObjectUrlEntry>();

const createObjectUrlEntry = (blob: Blob): ObjectUrlEntry => {
  const url = URL.createObjectURL(blob);
  return {
    url,
    revoke: () => {
      URL.revokeObjectURL(url);
    },
    holders: 0,
  };
};

const holdObjectUrl = (blob: Blob) => {
  const entry = objectUrls.get(blob) ?? createObjectUrlEntry(blob);
  entry.holders += 1;
  objectUrls.set(blob, entry);
  return () => {
    entry.holders -= 1;
    queueMicrotask(() => {
      if (entry.holders === 0 && objectUrls.get(blob) === entry) {
        objectUrls.delete(blob);
        entry.revoke();
      }
    });
  };
};

const NO_SUBSCRIPTION = () => () => undefined;

// One subscribe function per blob, so the store keeps its subscription
// across renders instead of re-subscribing every time.
const objectUrlSubscriptions = new WeakMap<
  Blob,
  (onChange: () => void) => () => void
>();
const subscribeObjectUrl = (blob: Blob) => {
  const existing = objectUrlSubscriptions.get(blob);
  if (existing) {
    return existing;
  }
  const subscribe = (onChange: () => void) => {
    const release = holdObjectUrl(blob);
    onChange();
    return release;
  };
  objectUrlSubscriptions.set(blob, subscribe);
  return subscribe;
};

/**
 * An object URL for `blob` while the component shows it, revoked when the
 * last component holding it lets go. `undefined` without a blob.
 */
export const useObjectUrl = (
  blob: Blob | null | undefined,
): string | undefined =>
  useSyncExternalStore(
    blob ? subscribeObjectUrl(blob) : NO_SUBSCRIPTION,
    () => (blob ? objectUrls.get(blob)?.url : undefined),
    () => undefined,
  );
