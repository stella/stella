// Passive regression fixture for `no-raw-use-effect/no-raw-use-effect`.
//
// Each `oxlint-disable-next-line` below suppresses a call the rule MUST flag.
// If the rule regresses (e.g. it stops tracking aliased or default-namespaced
// imports), the matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI. The wrapper
// calls at the end carry no disable, so the rule over-firing on them also
// fails CI.

import React, { useEffect, useEffect as useRenamedEffect } from "react";

const useMountEffect = (effect: () => void) => {
  effect();
};
const useExternalSyncEffect = (effect: () => void, _deps: unknown[]) => {
  effect();
};

function FixtureComponent({ value }: { value: number }) {
  const marker = React.useRef(0);
  const sync = () => {
    marker.current = value;
  };

  // Named import — MUST flag.
  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect
  useEffect(sync);

  // Aliased named import — MUST flag.
  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect
  useRenamedEffect(sync);

  // Default-namespaced access — MUST flag.
  // oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect
  React.useEffect(sync);

  // --- Cases the rule MUST NOT flag (sanctioned wrappers) ---
  useMountEffect(sync);
  useExternalSyncEffect(sync, [value]);

  return marker.current;
}

export const __noRawUseEffectFixture = FixtureComponent;
