import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const previousActEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, cleanup, render } = await import("@testing-library/react");
const { useHasMounted, useIsMounted, useKeyedState, useLatestCallback } =
  await import("./effects");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  await unregisterDomEnvironment();
});

describe("useKeyedState", () => {
  test("starts over from its initial value when the key changes, in the same commit", () => {
    const seen: string[] = [];
    let setDraft: ((value: string) => void) | null = null;
    const Draft = ({ id }: { id: string }) => {
      const [draft, set] = useKeyedState(id, () => `draft of ${id}`);
      setDraft = set;
      seen.push(draft);
      return <output>{draft}</output>;
    };
    const { container, rerender } = render(<Draft id="a" />);
    act(() => {
      setDraft?.("edited a");
    });
    expect(container.textContent).toBe("edited a");
    seen.length = 0;
    rerender(<Draft id="b" />);
    expect(container.textContent).toBe("draft of b");
    // The stale draft of `a` is never rendered under key `b`.
    expect(seen).not.toContain("edited a");
  });

  test("keeps one setter identity and skips renders for an unchanged value", () => {
    const setters = new Set<unknown>();
    let renders = 0;
    let setCount: ((update: (count: number) => number) => void) | null = null;
    const Counter = ({ id }: { id: number }) => {
      const [count, set] = useKeyedState(id, 0);
      setters.add(set);
      setCount = set;
      renders += 1;
      return <output data-count={count} />;
    };
    const { container, rerender } = render(<Counter id={1} />);
    act(() => {
      setCount?.((count) => count + 1);
    });
    expect(container.querySelector("output")?.dataset["count"]).toBe("1");
    const before = renders;
    act(() => {
      setCount?.((count) => count);
    });
    // React may render once more before it bails out; it never commits a change.
    expect(renders - before).toBeLessThanOrEqual(1);
    expect(container.querySelector("output")?.dataset["count"]).toBe("1");
    rerender(<Counter id={2} />);
    expect(container.querySelector("output")?.dataset["count"]).toBe("0");
    expect(setters.size).toBe(1);
  });
});

describe("useLatestCallback", () => {
  test("keeps one identity and calls the latest function", () => {
    const callbacks = new Set<() => string>();
    const Holder = ({ label }: { label: string }) => {
      callbacks.add(useLatestCallback(() => label));
      return null;
    };
    const { rerender } = render(<Holder label="first" />);
    rerender(<Holder label="second" />);
    expect(callbacks.size).toBe(1);
    const [latest] = callbacks;
    expect(latest?.()).toBe("second");
  });
});

describe("mount latches", () => {
  test("useHasMounted is false on the first render and true after the commit", () => {
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useHasMounted());
      return null;
    };
    render(<Probe />);
    expect(seen.at(0)).toBe(false);
    expect(seen.at(-1)).toBe(true);
  });

  test("useIsMounted reports the mount and the unmount", () => {
    const probe: { isMounted: (() => boolean) | null } = { isMounted: null };
    const Probe = () => {
      probe.isMounted = useIsMounted();
      return null;
    };
    const { unmount } = render(<Probe />);
    expect(probe.isMounted?.()).toBe(true);
    unmount();
    expect(probe.isMounted?.()).toBe(false);
  });
});
