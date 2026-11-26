import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  captureStorm,
  installDomTestStormGuard,
  stormStimulus,
} from "./dom-test-guard";

// The guard is the preload's (packages/render-probe/bunfig.toml); this
// returns the same instance.
const guard = installDomTestStormGuard();

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, useEffect, useState, useSyncExternalStore } =
  await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");

const roots: Root[] = [];

afterEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.replaceChildren();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const createTestRoot = () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  return { root, container };
};

const mount = async (element: ReactNode) => {
  const mounted = createTestRoot();
  await act(async () => {
    mounted.root.render(element);
  });
  return mounted;
};

const nextTurn = async () => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

/**
 * Sets fresh state on every commit, one microtask after its effect ran: the
 * shape of an effect that loads something and stores a new object each time.
 */
const EffectLoop = () => {
  const [value, setValue] = useState({});
  useEffect(() => {
    queueMicrotask(() => {
      setValue({});
    });
  }, [value]);
  return <span>looping</span>;
};

const Counter = ({ count }: { count: number }) => <output>{count}</output>;

const createStore = () => {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: () => value,
    set: (next: number) => {
      value = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
};

const StoreValue = ({ store }: { store: ReturnType<typeof createStore> }) => {
  const value = useSyncExternalStore(store.subscribe, store.read);
  return <output>{value}</output>;
};

/** Settles the running test by hand and starts a fresh one, returning the failure. */
const settleFailure = async (): Promise<string> => {
  let message = "";
  try {
    await guard.settle();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  guard.begin();
  return message;
};

test("an effect loop inside act() fails the test, naming the component", async () => {
  const { container } = await mount(<EffectLoop />);

  const message = await settleFailure();

  expect(message).toContain("Render storm");
  expect(message).toContain("Unstimulated");
  expect(message).toContain("EffectLoop");
  expect(message).toContain("unmounted the tree");
  // The loop ended: the check unmounted its root.
  expect(container.textContent).toBe("");
});

test("captureStorm collects the storm instead of failing", async () => {
  const report = await captureStorm(async () => await mount(<EffectLoop />));

  expect(report.violations.map(({ kind }) => kind)).toEqual(["unstimulated"]);
  expect(report.violations[0]?.components.at(0)?.name).toBe("EffectLoop");
  expect(report.violations[0]?.unmounted).toBe(true);
});

test("a loop outside act() is caught and ends", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  const { root, container } = createTestRoot();

  const report = await captureStorm(() => {
    root.render(<EffectLoop />);
  });

  expect(report.violations.length).toBeGreaterThan(0);
  expect(report.violations.at(0)?.components.at(0)?.name).toBe("EffectLoop");
  expect(container.textContent).toBe("");
});

test("captureStorm fails when nothing storms", async () => {
  await captureStorm(async () => await mount(<Counter count={1} />));

  expect(await settleFailure()).toContain(
    "captureStorm() expected a render storm",
  );
});

test("hundreds of rerenders, each in act(), pass", async () => {
  const { root, container } = await mount(<Counter count={0} />);
  for (let count = 1; count <= 400; count += 1) {
    await act(async () => {
      root.render(<Counter count={count} />);
    });
  }
  for (let count = 401; count <= 600; count += 1) {
    act(() => {
      root.render(<Counter count={count} />);
    });
  }

  expect(container.textContent).toBe("600");
});

test("commits a driver feeds outside act() pass when it says so", async () => {
  const store = createStore();
  const { container } = await mount(<StoreValue store={store} />);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);

  for (let value = 1; value <= 300; value += 1) {
    stormStimulus("stream");
    store.set(value);
    await nextTurn();
  }

  expect(container.textContent).toBe("300");
});

test("commits after a mocked response is read pass", async () => {
  const store = createStore();
  const { container } = await mount(<StoreValue store={store} />);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);

  for (let value = 1; value <= 300; value += 1) {
    const body: unknown = await new Response(JSON.stringify(value)).json();
    store.set(typeof body === "number" ? body : 0);
    await nextTurn();
  }

  expect(container.textContent).toBe("300");
});

test("the same commits with no stimulus drain the bucket", async () => {
  const store = createStore();
  await mount(<StoreValue store={store} />);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);

  const report = await captureStorm(() => {
    for (let value = 1; value <= 300; value += 1) {
      flushSync(() => {
        store.set(value);
      });
    }
  });

  expect(report.violations.map(({ kind }) => kind)).toContain("unstimulated");
  expect(report.violations[0]?.components.at(0)?.name).toBe("StoreValue");
});
