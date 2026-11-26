// The sanctioned React effect hooks, and the only module outside
// `./dom.ts` that may call a raw effect or write state from one
// (no-raw-use-effect, no-effect-state-write). Every other React file
// reaches effects through these names, so each remaining effect is a
// greppable, explicit sync with something outside React.
//
// Excluded from the React Compiler (REACT_COMPILER_EXCLUDE): the wrappers
// take opaque callbacks and dependency arrays, and every identity they hand
// out is kept stable by hand, so they behave the same compiled or not (the
// desktop app, the package's own tests and outside consumers run them
// uncompiled). The wrappers forward their callers' dependency arrays
// verbatim, so exhaustive-deps is off here by configuration (oxlint.config.ts)
// and on at every call site. Full rationale: /conventions-use-effect.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  DependencyList,
  Dispatch,
  EffectCallback,
  RefObject,
  SetStateAction,
} from "react";

/**
 * Setup/teardown synchronization with an external system, once per mount.
 * Use for DOM imperatives (focus, scroll), third-party widget lifecycles,
 * and browser-API subscriptions. To start fresh when an id changes, remount
 * with a `key` instead of adding a dependency here.
 */
export const useMountEffect = (effect: EffectCallback): void => {
  useEffect(effect, []);
};

/**
 * Push a *changing* React value into an external system when it changes
 * (e.g. an imperative editor's zoom or content). Every call must be an
 * external-system sync — never derived state, an event relay, or data
 * fetching.
 */
export const useExternalSyncEffect = (
  effect: EffectCallback,
  deps: DependencyList,
): void => {
  useEffect(effect, deps);
};

/**
 * The layout twin of `useExternalSyncEffect`: a host write that must land
 * before the browser paints (scroll anchoring, zoom, a class toggle, an
 * animated value, registering with a registry other layout effects read).
 * Never React state: a value measured from the DOM goes through
 * `useLayoutMeasurement` (`@stll/ui/effects/dom`).
 */
export const useLayoutSyncEffect = (
  effect: EffectCallback,
  deps: DependencyList,
): void => {
  useLayoutEffect(effect, deps);
};

/** The mount-only layout twin: a registration or host write before paint. */
export const useMountLayoutEffect = (effect: EffectCallback): void => {
  useLayoutEffect(effect, []);
};

/**
 * A ref that always holds the latest committed value, readable from
 * event handlers, imperative bridges, and async paths without making
 * them depend on the value.
 *
 * The write happens in a layout effect, so readers see the value of the
 * last committed render. Never read the returned ref during render;
 * derive render output from the value directly instead. Replaces
 * hand-written render-body mirrors (`ref.current = value`), which
 * `no-ref-mirror` bans.
 */
export const useLatest = <T>(value: T): RefObject<T> => {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
};

/**
 * A function with one identity for the component's lifetime that always
 * calls the latest committed `fn`. Hand it to systems outside React's
 * render and effect lifecycle: query contexts, imperative editor bridges,
 * external emitters, listeners registered by an effect.
 *
 * Never call it during render. It switches to the new `fn` on passive-effect
 * timing: until the commit's passive effects run, it still calls the previous
 * one. Layout timing would let a child's layout effect call a callback from
 * a render that has not finished committing, which feeds loops in editors
 * that call back synchronously.
 */
export const useLatestCallback = <A extends unknown[], R>(
  fn: (...args: A) => R,
): ((...args: A) => R) => {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  }, [fn]);
  const [stable] = useState(
    () =>
      (...args: A): R =>
        latest.current(...args),
  );
  return stable;
};

/**
 * Whether the component is mounted, for async continuations that must not
 * act after it unmounts. Read it from callbacks, never during render.
 */
export const useIsMounted = (): (() => boolean) => {
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [isMounted] = useState(() => () => mounted.current);
  return isMounted;
};

/**
 * `false` on the first render, `true` from the render after mount: the one
 * mount latch, for work that must not start before the component commits
 * (a chrome query whose fetch could otherwise resolve on a fiber that has
 * not mounted yet). It costs one extra render per mount and never more.
 */
export const useHasMounted = (): boolean => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
};

/** A value `useKeyedState` can key on: compared with `Object.is`. */
export type StateKey = string | number | boolean | null | undefined;

const isUpdater = <T>(action: SetStateAction<T>): action is (value: T) => T =>
  typeof action === "function";

const isInitializer = <T>(initial: T | (() => T)): initial is () => T =>
  typeof initial === "function";

/**
 * Local state that starts over from `initial` whenever `key` changes: the
 * draft of the record whose id is `key`, a selection that belongs to one
 * result set. Prefer remounting with `key` when the whole subtree may start
 * over; use this when sibling state must survive the reset.
 *
 * It replaces an effect that resets state when a prop changes. The reset
 * happens during the render that sees the new key, before anything
 * commits, so no stale value is ever shown and no extra commit happens.
 * The setter has one identity for the component's lifetime and bails out
 * when the value does not change.
 */
export const useKeyedState = <T>(
  key: StateKey,
  initial: T | (() => T),
): readonly [T, Dispatch<SetStateAction<T>>] => {
  const resolve = (): T => (isInitializer(initial) ? initial() : initial);
  const [slot, setSlot] = useState(() => ({ key, value: resolve() }));
  const [setValue] = useState(() => (action: SetStateAction<T>): void => {
    setSlot((current) => {
      const value = isUpdater(action) ? action(current.value) : action;
      return Object.is(value, current.value)
        ? current
        : { key: current.key, value };
    });
  });
  if (!Object.is(slot.key, key)) {
    // React discards this render and renders again with the new slot before
    // committing; the comparison is by `Object.is`, so it settles at once.
    const next = { key, value: resolve() };
    setSlot(next);
    return [next.value, setValue];
  }
  return [slot.value, setValue];
};
