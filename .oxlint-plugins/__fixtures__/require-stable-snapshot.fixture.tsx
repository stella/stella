// Passive regression fixture for
// `require-stable-snapshot/require-stable-snapshot`.
//
// Each `oxlint-disable-next-line` below suppresses a call the rule MUST flag.
// If the rule regresses (e.g. it stops checking argument 3, or starts
// flagging identifier/member snapshot args), the matching disable becomes
// unused and `--report-unused-disable-directives-severity=error` fails CI.
// The calls at the end carry no disable, so the rule over-firing on them also
// fails CI.

import React, {
  useSyncExternalStore,
  useSyncExternalStore as useRenamedSyncExternalStore,
} from "react";

const subscribe = () => () => undefined;
const cachedSnapshot = { value: 1 };
const cachedList = [1, 2, 3];
const getCachedSnapshot = () => cachedSnapshot;
const items = [1, 2, 3];
const baseSnapshot: { value: number } = { value: 0 };

function FixtureComponent() {
  // getSnapshot returns a fresh object literal — MUST flag.
  // oxlint-disable-next-line require-stable-snapshot/require-stable-snapshot
  useSyncExternalStore(subscribe, () => ({ value: 1 }));

  // getSnapshot returns a fresh array literal — MUST flag.
  // oxlint-disable-next-line require-stable-snapshot/require-stable-snapshot
  useSyncExternalStore(subscribe, () => [1, 2, 3]);

  // getServerSnapshot (argument 3) returns a fresh object literal — MUST flag.
  // oxlint-disable-next-line require-stable-snapshot/require-stable-snapshot
  useSyncExternalStore(subscribe, getCachedSnapshot, () => ({ value: 1 }));

  // Block-body `return` producing an array literal — MUST flag.
  // oxlint-disable-next-line require-stable-snapshot/require-stable-snapshot
  useSyncExternalStore(subscribe, () => {
    void items.length;
    return [...items];
  });

  // getSnapshot returns a `.map()` call — a fresh-reference producer — MUST
  // flag.
  // oxlint-disable-next-line require-stable-snapshot/require-stable-snapshot
  useSyncExternalStore(subscribe, () => items.map((item) => item * 2));

  // getSnapshot returns `Object.assign(...)` — a fresh-reference producer —
  // MUST flag.
  // oxlint-disable-next-line require-stable-snapshot/require-stable-snapshot
  useSyncExternalStore(subscribe, () =>
    Object.assign(baseSnapshot, cachedSnapshot),
  );

  // Aliased named import, fresh array literal — MUST flag.
  // oxlint-disable-next-line require-stable-snapshot/require-stable-snapshot
  useRenamedSyncExternalStore(subscribe, () => [1]);

  // `React.useSyncExternalStore` namespace access, fresh object literal —
  // MUST flag.
  // oxlint-disable-next-line require-stable-snapshot/require-stable-snapshot
  React.useSyncExternalStore(subscribe, () => ({ value: 1 }));

  // --- Cases the rule MUST NOT flag ---

  // Named function references for subscribe/getSnapshot/getServerSnapshot —
  // the real fix (cache at the source), and the rule cannot see inside them.
  useSyncExternalStore(subscribe, getCachedSnapshot, getCachedSnapshot);

  // Inline getSnapshot returning an already-cached identifier.
  useSyncExternalStore(subscribe, () => cachedSnapshot);
  useSyncExternalStore(subscribe, () => cachedList);

  // Inline getSnapshot returning a primitive.
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  // Inline getSnapshot returning a member expression.
  useSyncExternalStore(subscribe, () => cachedSnapshot.value);

  // Inline getSnapshot calling a non-fresh-reference-producing method.
  useSyncExternalStore(subscribe, () => items.includes(1));

  // Block body returning a cached identifier from every branch.
  useSyncExternalStore(subscribe, () => {
    if (items.length > 0) {
      return cachedSnapshot;
    }
    return cachedSnapshot;
  });

  return null;
}

export const __requireStableSnapshotFixture = FixtureComponent;
