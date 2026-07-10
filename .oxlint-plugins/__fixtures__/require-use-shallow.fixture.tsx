// Passive regression fixture for `require-use-shallow/require-use-shallow`.
//
// Each `oxlint-disable-next-line` below suppresses a call the rule MUST flag.
// If the rule regresses (e.g. it stops walking `return` statements, or starts
// treating `useShallow`-wrapped selectors as violations), the matching
// disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI. The calls at
// the end carry no disable, so the rule over-firing on them also fails CI.

import { create, createStore, useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";

type FixtureState = {
  a: string;
  b: number;
  list: string[];
  getA: () => string;
};

const useFixtureStore = create<FixtureState>((set, get) => ({
  a: "a",
  b: 1,
  list: [],
  getA: () => get().a,
}));

const fixtureStore = createStore<FixtureState>((set, get) => ({
  a: "a",
  b: 1,
  list: [],
  getA: () => get().a,
}));

function FixtureComponent() {
  // Implicit-body object literal — MUST flag.
  // oxlint-disable-next-line require-use-shallow/require-use-shallow
  const objectSelector = useFixtureStore((s) => ({ a: s.a, b: s.b }));

  // Implicit-body array literal — MUST flag.
  // oxlint-disable-next-line require-use-shallow/require-use-shallow
  const arraySelector = useFixtureStore((s) => [s.a, s.b]);

  // Block-body `return` producing an object literal — MUST flag.
  // oxlint-disable-next-line require-use-shallow/require-use-shallow
  const blockObjectSelector = useFixtureStore((s) => {
    void s.b;
    return { a: s.a, b: s.b };
  });

  // `return` nested inside an `if` producing an array literal — MUST flag.
  // oxlint-disable-next-line require-use-shallow/require-use-shallow
  const nestedReturnSelector = useFixtureStore((s) => {
    if (s.b > 0) {
      return [s.a];
    }
    return [];
  });

  // Bare zustand `useStore(store, selector)` two-argument form — MUST flag.
  // oxlint-disable-next-line require-use-shallow/require-use-shallow
  const bareStoreSelector = useStore(fixtureStore, (s) => ({ a: s.a }));

  // --- Cases the rule MUST NOT flag ---

  // Selecting a primitive field.
  const primitiveSelector = useFixtureStore((s) => s.a);

  // Selecting via a member/call expression, not an object/array literal.
  const derivedSelector = useFixtureStore((s) => s.getA());

  // Block body returning a primitive from every branch (real shape used in
  // the app for boolean/id "is this active" selectors).
  const blockPrimitiveSelector = useFixtureStore((s) => {
    if (s.b > 0) {
      return s.a;
    }
    return null;
  });

  // Wrapped in `useShallow` — the correct fix, must stay clean.
  const shallowObjectSelector = useFixtureStore(
    useShallow((s) => ({ a: s.a, b: s.b })),
  );
  const shallowArraySelector = useFixtureStore(useShallow((s) => [s.a, s.b]));

  // No selector argument at all.
  const wholeStore = useFixtureStore();

  // Bare `useStore(store, selector)` selecting a primitive.
  const bareStorePrimitive = useStore(fixtureStore, (s) => s.a);

  return (
    <div>
      {objectSelector.a}
      {arraySelector[0]}
      {blockObjectSelector.a}
      {nestedReturnSelector[0]}
      {bareStoreSelector.a}
      {primitiveSelector}
      {derivedSelector}
      {blockPrimitiveSelector}
      {shallowObjectSelector.a}
      {shallowArraySelector[0]}
      {wholeStore.a}
      {bareStorePrimitive}
    </div>
  );
}

export const __requireUseShallowFixture = FixtureComponent;
