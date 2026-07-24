import { useEffect } from "react";
import type { DependencyList, EffectCallback } from "react";

// The only sanctioned callers of a raw `useEffect` in apps/web. Direct
// `useEffect` is banned by the no-raw-use-effect lint rule so that every
// remaining effect is an explicit, greppable external-system sync.
// Full rationale + decision table: /conventions-use-effect.

/**
 * Setup/teardown synchronization with an external system, once per mount.
 * Use for DOM imperatives (focus, scroll), third-party widget lifecycles,
 * and browser-API subscriptions. To start fresh when an id changes, remount
 * with a `key` instead of adding a dependency here.
 */
export const useMountEffect = (effect: EffectCallback) => {
  // eslint-disable-next-line react/react-compiler -- the exhaustive-deps exception below intentionally opts this wrapper out of compiler memoization
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design; `effect` is intentionally excluded so it runs exactly once
  useEffect(effect, []);
};

/**
 * Push a *changing* React value into an external system when it changes
 * (e.g. an imperative editor's zoom or content). This is the only sanctioned
 * dependency-array effect: every call must be an external-system sync — never
 * derived state, an event relay, or data fetching.
 */
export const useExternalSyncEffect = (
  effect: EffectCallback,
  deps: DependencyList,
) => {
  // eslint-disable-next-line react/react-compiler -- the exhaustive-deps exception below intentionally opts this wrapper out of compiler memoization
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the wrapper forwards the caller's deps verbatim; correctness of `deps` is the caller's contract
  useEffect(effect, deps);
};
