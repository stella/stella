// Counts what React renders on every commit, per component and by cause.
//
// A commit-rate budget (the web app's render-storm canary) cannot see how
// wide each commit is: a page that re-renders every finished message for
// each streamed token commits no more often than one that re-renders only
// the streaming row. This probe names the components each commit rendered
// and why, so a budget can hold the width too.
//
// It installs itself as React's DevTools hook, which React DOM and React
// Native both report every commit to, so one probe serves the web DOM tests,
// the web e2e app and the mobile development build. Install it before React
// loads (`@stll/render-probe/install`): a renderer reads the hook once, when
// its module initialises.
//
// The walk follows React DevTools' own rule: descend only into a fiber whose
// child list changed, and count a component only when React performed work
// on it this commit. A subtree React bailed out of keeps the flags of an
// older commit, so reading flags there would report renders that never
// happened.

/** Why a component rendered in a commit. */
export type RenderCause =
  /** First render. */
  | "mount"
  /** Its props changed. */
  | "props"
  /**
   * Its parent rendered and handed it props equal to the last ones: a render
   * a memo boundary would have spared.
   */
  | "parent"
  /** One of its own state hooks (or its class state) changed. */
  | "state"
  /** Props and state were unchanged: a context it reads changed. */
  | "context";

export const RENDER_CAUSES = [
  "mount",
  "props",
  "parent",
  "state",
  "context",
] as const satisfies readonly RenderCause[];

export type ComponentRenders = {
  renders: number;
  causes: Record<RenderCause, number>;
};

export type RenderSnapshot = {
  /** Commits since the last reset. */
  commits: number;
  /** Component renders since the last reset, across all commits. */
  renders: number;
  /** The most components one commit rendered. */
  widestCommit: number;
  /**
   * Component renders by cause, across all components. `parent` counts the
   * renders a memo boundary would have spared.
   */
  causes: Record<RenderCause, number>;
  /** By component name. */
  components: Record<string, ComponentRenders>;
};

export type RenderProbe = {
  /** Forget everything counted so far; counting continues. */
  readonly reset: () => void;
  readonly snapshot: () => RenderSnapshot;
};

/** Where drivers outside the process (Playwright, the Hermes inspector) find the probe. */
export const RENDER_PROBE_GLOBAL = "__STLL_RENDER_PROBE__";

const DEVTOOLS_HOOK = "__REACT_DEVTOOLS_GLOBAL_HOOK__";

// React's fiber tags for components, and the flag a render sets.
const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const FORWARD_REF = 11;
const MEMO_COMPONENT = 14;
const SIMPLE_MEMO_COMPONENT = 15;
const COMPONENT_TAGS: ReadonlySet<number> = new Set([
  FUNCTION_COMPONENT,
  CLASS_COMPONENT,
  FORWARD_REF,
  MEMO_COMPONENT,
  SIMPLE_MEMO_COMPONENT,
]);
// PerformedWork is the flags' lowest bit.
const performedWork = (flags: number): boolean => flags % 2 === 1;

/** The fields of React's fiber the walk reads. */
type Fiber = {
  readonly tag: number;
  readonly type: unknown;
  readonly elementType: unknown;
  readonly flags: number;
  readonly memoizedProps: unknown;
  readonly memoizedState: unknown;
  readonly alternate: Fiber | null;
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
};

type FiberRoot = { readonly current: Fiber };

type Hook = {
  supportsFiber?: boolean;
  renderers?: Map<number, unknown>;
  inject?: (internals: unknown) => number;
  onCommitFiberRoot?: (
    rendererId: number,
    root: FiberRoot,
    ...rest: unknown[]
  ) => void;
  onCommitFiberUnmount?: (...args: unknown[]) => void;
  onPostCommitFiberRoot?: (...args: unknown[]) => void;
  checkDCE?: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nameOfType = (type: unknown): string | undefined => {
  if (typeof type === "function") {
    const named: unknown = Reflect.get(type, "displayName") ?? type.name;
    return typeof named === "string" && named !== "" ? named : undefined;
  }
  if (!isRecord(type)) {
    return undefined;
  }
  const displayName = type["displayName"];
  if (typeof displayName === "string" && displayName !== "") {
    return displayName;
  }
  // forwardRef keeps its component in `render`, memo in `type`.
  return nameOfType(type["render"]) ?? nameOfType(type["type"]);
};

const nameOf = (fiber: Fiber): string =>
  nameOfType(fiber.type) ?? nameOfType(fiber.elementType) ?? "Anonymous";

const shallowEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]),
    )
  );
};

/**
 * Whether a component's own state changed. A function component's
 * `memoizedState` is its hook list, rebuilt on every render, so its state
 * hooks (the ones with an update queue) are compared value by value.
 */
const stateChanged = (next: Fiber, previous: Fiber): boolean => {
  if (next.tag === CLASS_COMPONENT) {
    return !Object.is(next.memoizedState, previous.memoizedState);
  }
  let nextHook: unknown = next.memoizedState;
  let previousHook: unknown = previous.memoizedState;
  while (isRecord(nextHook) && isRecord(previousHook)) {
    if (
      nextHook["queue"] !== null &&
      nextHook["queue"] !== undefined &&
      !Object.is(nextHook["memoizedState"], previousHook["memoizedState"])
    ) {
      return true;
    }
    nextHook = nextHook["next"];
    previousHook = previousHook["next"];
  }
  return false;
};

const causeOf = (next: Fiber, previous: Fiber | null): RenderCause => {
  if (previous === null) {
    return "mount";
  }
  if (stateChanged(next, previous)) {
    return "state";
  }
  if (!Object.is(next.memoizedProps, previous.memoizedProps)) {
    return shallowEqual(next.memoizedProps, previous.memoizedProps)
      ? "parent"
      : "props";
  }
  return "context";
};

const emptyCauses = (): Record<RenderCause, number> => ({
  mount: 0,
  props: 0,
  parent: 0,
  state: 0,
  context: 0,
});

/** A probe that counts the commits it is handed; `installRenderProbe` wires it to React. */
export const createRenderProbe = () => {
  let totals = { commits: 0, renders: 0, widestCommit: 0 };
  let components = new Map<string, ComponentRenders>();

  const record = (fiber: Fiber, previous: Fiber | null) => {
    const name = nameOf(fiber);
    const entry = components.get(name) ?? {
      renders: 0,
      causes: emptyCauses(),
    };
    components.set(name, entry);
    entry.renders += 1;
    entry.causes[causeOf(fiber, previous)] += 1;
  };

  /** A fiber React created this commit, and the subtree it mounted. */
  const mount = (fiber: Fiber): number => {
    let rendered = 0;
    if (COMPONENT_TAGS.has(fiber.tag)) {
      record(fiber, null);
      rendered += 1;
    }
    for (let child = fiber.child; child !== null; child = child.sibling) {
      rendered += mount(child);
    }
    return rendered;
  };

  /** A fiber that existed before this commit, and what React redid under it. */
  const update = (next: Fiber, previous: Fiber): number => {
    let rendered = 0;
    if (COMPONENT_TAGS.has(next.tag) && performedWork(next.flags)) {
      record(next, previous);
      rendered += 1;
    }
    // An unchanged child list is a subtree React bailed out of entirely.
    if (next.child === previous.child) {
      return rendered;
    }
    for (let child = next.child; child !== null; child = child.sibling) {
      const before = child.alternate;
      rendered += before === null ? mount(child) : update(child, before);
    }
    return rendered;
  };

  const onCommit = (root: FiberRoot) => {
    const current = root.current;
    const previous = current.alternate;
    const rendered =
      previous === null ? mount(current) : update(current, previous);
    totals = {
      commits: totals.commits + 1,
      renders: totals.renders + rendered,
      widestCommit: Math.max(totals.widestCommit, rendered),
    };
  };

  const causeTotals = () => {
    const causes = emptyCauses();
    for (const entry of components.values()) {
      for (const cause of RENDER_CAUSES) {
        causes[cause] += entry.causes[cause];
      }
    }
    return causes;
  };

  const probe: RenderProbe = {
    reset: () => {
      totals = { commits: 0, renders: 0, widestCommit: 0 };
      components = new Map();
    },
    snapshot: () => ({
      ...totals,
      causes: causeTotals(),
      components: Object.fromEntries(
        [...components].map(([name, entry]) => [
          name,
          { renders: entry.renders, causes: { ...entry.causes } },
        ]),
      ),
    }),
  };
  return { probe, onCommit };
};

const INSTALLED = new WeakMap<object, RenderProbe>();

/** The probe installed on `target`, if any. */
export const installedRenderProbe = (
  target: object = globalThis,
): RenderProbe | undefined => INSTALLED.get(target);

/**
 * Installs the probe as React's DevTools hook, or chains onto the hook the
 * React DevTools extension already installed. Idempotent: a second call
 * returns the installed probe.
 */
export const installRenderProbe = (
  target: object = globalThis,
): RenderProbe => {
  const installed = INSTALLED.get(target);
  if (installed !== undefined) {
    return installed;
  }
  const { probe, onCommit } = createRenderProbe();
  INSTALLED.set(target, probe);
  const existing: unknown = Reflect.get(target, DEVTOOLS_HOOK);
  if (isRecord(existing)) {
    const hook: Hook = existing;
    const previous = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = (rendererId, root, ...rest) => {
      onCommit(root);
      previous?.call(hook, rendererId, root, ...rest);
    };
  } else {
    const renderers = new Map<number, unknown>();
    const hook: Hook = {
      supportsFiber: true,
      renderers,
      inject: (internals) => {
        const id = renderers.size + 1;
        renderers.set(id, internals);
        return id;
      },
      onCommitFiberRoot: (_rendererId, root) => {
        onCommit(root);
      },
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
    };
    Reflect.set(target, DEVTOOLS_HOOK, hook);
  }
  Reflect.set(target, RENDER_PROBE_GLOBAL, probe);
  return probe;
};
