/* oxlint-disable react/rules-of-hooks, typescript/dot-notation, import/no-duplicates, no-duplicate-imports, no-shadow -- fixture: each binding form stands on its own line */

// Passive regression fixture for
// `no-raw-use-layout-effect/no-raw-use-layout-effect`.
//
// React's `useLayoutEffect` and `useInsertionEffect` are reported where they
// come into scope, however they are reached, so an alias picked at runtime
// (`cond ? useEffect : useLayoutEffect`) or a hook passed as a value is
// caught too. The sanctioned wrappers, React's other hooks and an unrelated
// local function of the same name are clean.

// oxlint-disable-next-line no-raw-use-layout-effect/no-raw-use-layout-effect -- named import
import { useLayoutEffect } from "react";
// oxlint-disable-next-line no-raw-use-layout-effect/no-raw-use-layout-effect -- aliased insertion effect
import { useInsertionEffect as useRenamedInsertionEffect } from "react";
// expect-clean: no-raw-use-layout-effect/no-raw-use-layout-effect
import React, { useMemo } from "react";
// expect-clean: no-raw-use-layout-effect/no-raw-use-layout-effect
import * as ReactNamespace from "react";

const useLayoutSyncEffect = (effect: () => void, _deps: unknown[]) => {
  effect();
};
const useMountLayoutEffect = (effect: () => void) => {
  effect();
};

// The isomorphic alias: the hook is chosen as a value, never called by name.
const useIsoLayoutEffect =
  typeof window === "undefined" ? React.useEffect : useLayoutEffect;

// oxlint-disable-next-line no-raw-use-layout-effect/no-raw-use-layout-effect -- destructured from the default import
const { useLayoutEffect: useDestructuredLayoutEffect } = React;

function FixtureComponent({ value }: { value: number }) {
  const marker = React.useRef(0);
  const sync = () => {
    marker.current = value;
  };

  useIsoLayoutEffect(sync);
  useRenamedInsertionEffect(sync);
  useDestructuredLayoutEffect(sync);
  // oxlint-disable-next-line no-raw-use-layout-effect/no-raw-use-layout-effect -- default import member
  React.useLayoutEffect(sync);
  // oxlint-disable-next-line no-raw-use-layout-effect/no-raw-use-layout-effect -- computed member
  React["useInsertionEffect"](sync);
  // oxlint-disable-next-line no-raw-use-layout-effect/no-raw-use-layout-effect -- namespace import member
  ReactNamespace.useLayoutEffect(sync);

  // expect-clean: no-raw-use-layout-effect/no-raw-use-layout-effect
  useLayoutSyncEffect(sync, [value]);
  // expect-clean: no-raw-use-layout-effect/no-raw-use-layout-effect
  useMountLayoutEffect(sync);
  // expect-clean: no-raw-use-layout-effect/no-raw-use-layout-effect
  const doubled = useMemo(() => value * 2, [value]);

  return marker.current + doubled;
}

const loadLayoutEffect = async (sync: () => void) => {
  // oxlint-disable-next-line no-raw-use-layout-effect/no-raw-use-layout-effect -- awaited dynamic import with destructuring
  const { useLayoutEffect: useLoadedLayoutEffect } = await import("react");
  useLoadedLayoutEffect(sync);
};

const localHelpers = (sync: () => void) => {
  const useLayoutEffect = (effect: () => void) => effect();
  // expect-clean: no-raw-use-layout-effect/no-raw-use-layout-effect
  useLayoutEffect(sync);
};

// oxlint-disable-next-line no-raw-use-layout-effect/no-raw-use-layout-effect -- named re-export
export { useInsertionEffect as reexportedInsertionEffect } from "react";

export const __noRawUseLayoutEffectFixture = FixtureComponent;
export { loadLayoutEffect, localHelpers };
