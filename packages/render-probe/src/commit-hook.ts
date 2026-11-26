// One React DevTools hook, any number of commit listeners.
//
// A renderer reads `__REACT_DEVTOOLS_GLOBAL_HOOK__` once, when its module
// initialises, hands the hook its internals (`inject`) and then reports every
// commit to it. Several tools want those commits in one process (the DOM-test
// storm guard from a preload, a render probe a test installs later), so the
// hook keeps a listener list instead of each tool replacing or rewrapping it.
//
// Installing is idempotent per target: a second install, from another module
// instance of this file (a preload re-run per test file), returns the hook
// already there. If something else installed a hook first (the React DevTools
// extension), this one chains onto it.

/** The fields of a fiber root a listener receives; the probe reads more. */
export type CommitRoot = { readonly current: unknown };

/**
 * What a renderer hands the hook in `inject`. `currentDispatcherRef` is the
 * shared internals object of the React copy that renderer uses, so its
 * `actQueue` is the queue of that copy's `act()`. `scheduleRoot` exists in
 * development builds only.
 */
export type RendererInternals = {
  readonly currentDispatcherRef?: { readonly actQueue?: unknown };
  readonly scheduleRoot?: (root: CommitRoot, element: null) => void;
};

export type CommitListener = (
  root: CommitRoot,
  renderer: RendererInternals | undefined,
) => void;

export type RendererListener = (renderer: RendererInternals) => void;

export type CommitHook = {
  /** Calls `listener` on every commit until the returned function runs. */
  readonly listen: (listener: CommitListener) => () => void;
  /** Calls `listener` for every renderer injected so far and from now on. */
  readonly onRenderer: (listener: RendererListener) => () => void;
};

const DEVTOOLS_HOOK = "__REACT_DEVTOOLS_GLOBAL_HOOK__";
const REGISTRY = Symbol.for("stll.render-probe.commit-hook");

type DevtoolsHook = {
  supportsFiber?: boolean;
  renderers?: Map<number, unknown>;
  inject?: (internals: unknown) => number;
  onCommitFiberRoot?: (
    rendererId: number,
    root: CommitRoot,
    ...rest: unknown[]
  ) => void;
  onCommitFiberUnmount?: (...args: unknown[]) => void;
  onPostCommitFiberRoot?: (...args: unknown[]) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCommitHook = (value: unknown): value is CommitHook =>
  isRecord(value) &&
  typeof value["listen"] === "function" &&
  typeof value["onRenderer"] === "function";

/** Installs React's DevTools hook on `target`, or chains onto one already there. */
export const installCommitHook = (target: object = globalThis): CommitHook => {
  const installed: unknown = Reflect.get(target, REGISTRY);
  if (isCommitHook(installed)) {
    return installed;
  }

  const listeners = new Set<CommitListener>();
  const rendererListeners = new Set<RendererListener>();
  const renderers = new Map<number, RendererInternals>();

  const injected = (id: number, internals: unknown) => {
    const renderer: RendererInternals = isRecord(internals) ? internals : {};
    renderers.set(id, renderer);
    for (const listener of rendererListeners) {
      listener(renderer);
    }
  };
  const committed = (id: number, root: CommitRoot) => {
    const renderer = renderers.get(id);
    for (const listener of listeners) {
      listener(root, renderer);
    }
  };

  const existing: unknown = Reflect.get(target, DEVTOOLS_HOOK);
  if (isRecord(existing)) {
    const hook: DevtoolsHook = existing;
    const previousInject = hook.inject;
    const previousCommit = hook.onCommitFiberRoot;
    hook.inject = (internals) => {
      const id =
        previousInject === undefined
          ? renderers.size + 1
          : previousInject.call(hook, internals);
      injected(id, internals);
      return id;
    };
    hook.onCommitFiberRoot = (rendererId, root, ...rest) => {
      committed(rendererId, root);
      previousCommit?.call(hook, rendererId, root, ...rest);
    };
  } else {
    const hookRenderers = new Map<number, unknown>();
    const hook: DevtoolsHook = {
      supportsFiber: true,
      renderers: hookRenderers,
      inject: (internals) => {
        const id = hookRenderers.size + 1;
        hookRenderers.set(id, internals);
        injected(id, internals);
        return id;
      },
      onCommitFiberRoot: (rendererId, root) => {
        committed(rendererId, root);
      },
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
    };
    Reflect.set(target, DEVTOOLS_HOOK, hook);
  }

  const commitHook: CommitHook = {
    listen: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onRenderer: (listener) => {
      rendererListeners.add(listener);
      for (const renderer of renderers.values()) {
        listener(renderer);
      }
      return () => {
        rendererListeners.delete(listener);
      };
    },
  };
  Reflect.set(target, REGISTRY, commitHook);
  return commitHook;
};
