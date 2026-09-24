/* oxlint-disable unicorn/prefer-module, node/global-require, react-hooks/rules-of-hooks, typescript/dot-notation, no-shadow -- fixture: each call form stands on its own line */

// Passive regression fixture for `no-raw-use-effect/no-raw-use-effect`.
//
// React's `useEffect` is reported at each call, however the binding was
// reached, so a suppression names one call site. The import itself is not
// reported; the sanctioned wrappers and an unrelated local `useEffect` are
// clean.

// expect-clean: no-raw-use-effect/no-raw-use-effect
import React, { useEffect, useEffect as useRenamedEffect } from "react";
// expect-clean: no-raw-use-effect/no-raw-use-effect
import * as ReactNamespace from "react";

const useMountEffect = (effect: () => void) => {
  effect();
};
const useExternalSyncEffect = (effect: () => void, _deps: unknown[]) => {
  effect();
};

// expect-clean: no-raw-use-effect/no-raw-use-effect
const { useEffect: useDestructuredEffect } = React;

function FixtureComponent({ value }: { value: number }) {
  const marker = React.useRef(0);
  const sync = () => {
    marker.current = value;
  };

  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- named import
  useEffect(sync);
  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- aliased import
  useRenamedEffect(sync);
  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- default import member
  React.useEffect(sync);
  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- computed member
  React["useEffect"](sync);
  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- namespace import member
  ReactNamespace.useEffect(sync);
  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- destructured from the default import
  useDestructuredEffect(sync);
  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- require member
  require("react").useEffect(sync);

  // expect-clean: no-raw-use-effect/no-raw-use-effect
  useMountEffect(sync);
  // expect-clean: no-raw-use-effect/no-raw-use-effect
  useExternalSyncEffect(sync, [value]);

  return marker.current;
}

const loadEffect = async (sync: () => void) => {
  const { useEffect: useLoadedEffect } = await import("react");
  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- awaited dynamic import with destructuring
  useLoadedEffect(sync);
};

const localHelpers = (sync: () => void) => {
  const useEffect = (effect: () => void) => effect();
  // expect-clean: no-raw-use-effect/no-raw-use-effect
  useEffect(sync);
};

// oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- named re-export
export { useEffect as reexportedEffect } from "react";

export const __noRawUseEffectFixture = FixtureComponent;
export { loadEffect, localHelpers };
