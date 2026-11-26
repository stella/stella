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
const { useState } = await import("react");
const {
  createOscillationBreaker,
  flatEqual,
  useLayoutMeasurement,
  useObjectUrl,
} = await import("./dom");

// A ResizeObserver the test drives by hand.
const observers = new Set<() => void>();
class ResizeObserverStub {
  readonly #callback: () => void;
  constructor(callback: () => void) {
    this.#callback = callback;
  }
  observe() {
    observers.add(this.#callback);
  }
  disconnect() {
    observers.delete(this.#callback);
  }
}
const previousResizeObserver = globalThis.ResizeObserver;
Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
const resizeAll = () => {
  for (const notify of observers) {
    notify();
  }
};

afterEach(() => {
  cleanup();
  observers.clear();
});

afterAll(async () => {
  Reflect.set(globalThis, "ResizeObserver", previousResizeObserver);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  await unregisterDomEnvironment();
});

describe("flatEqual", () => {
  test("compares scalars with Object.is and flat records by key", () => {
    expect(flatEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(flatEqual({ width: 1, height: 2 }, { height: 2, width: 1 })).toBe(
      true,
    );
    expect(flatEqual({ width: 1 }, { width: 1, height: 2 })).toBe(false);
    expect(flatEqual({ width: 1 }, null)).toBe(false);
  });
});

describe("createOscillationBreaker", () => {
  test("holds a strict two-value alternation and admits a drag", () => {
    let now = 0;
    const errors: unknown[] = [];
    const originalReportError = globalThis.reportError;
    globalThis.reportError = (error: unknown) => {
      errors.push(error);
    };
    try {
      const breaker = createOscillationBreaker(() => now);
      const admitted = Array.from({ length: 10 }, (_, index) => {
        now += 10;
        return breaker.admit(index % 2 === 0 ? 100 : 117);
      });
      expect(admitted.slice(0, 7).every(Boolean)).toBe(true);
      expect(admitted.at(-1)).toBe(false);
      expect(errors).toHaveLength(1);

      const drag = createOscillationBreaker(() => now);
      const dragged = Array.from({ length: 20 }, (_, index) => {
        now += 10;
        return drag.admit(100 + index);
      });
      expect(dragged.every(Boolean)).toBe(true);
    } finally {
      globalThis.reportError = originalReportError;
    }
  });
});

describe("useLayoutMeasurement", () => {
  test("measures before paint, follows resizes and skips unchanged values", () => {
    let height = 40;
    let renders = 0;
    const Measured = () => {
      const [element, setElement] = useState<HTMLDivElement | null>(null);
      const measured = useLayoutMeasurement(element, () => ({ height }), [], {
        height: 0,
      });
      renders += 1;
      return <div data-height={measured.height} ref={setElement} />;
    };
    const { container } = render(<Measured />);
    const shown = () => container.querySelector("div")?.dataset["height"];
    expect(shown()).toBe("40");
    const settled = renders;
    act(() => {
      resizeAll();
    });
    act(() => {
      resizeAll();
    });
    // An unchanged measurement commits nothing; React may render once more
    // before it bails out, never once per emit.
    expect(renders - settled).toBeLessThanOrEqual(1);
    height = 64;
    act(() => {
      resizeAll();
    });
    expect(shown()).toBe("64");
  });
});

describe("useObjectUrl", () => {
  test("shares one URL per blob and revokes it after the last holder", async () => {
    const revoked: string[] = [];
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      originalRevoke(url);
    };
    try {
      const blob = new Blob(["stella"], { type: "text/plain" });
      const Preview = () => <a href={useObjectUrl(blob)}>preview</a>;
      const { container, unmount } = render(
        <>
          <Preview />
          <Preview />
        </>,
      );
      const hrefs = [...container.querySelectorAll("a")].map((link) =>
        link.getAttribute("href"),
      );
      expect(hrefs[0]).toBeTruthy();
      expect(hrefs[1]).toBe(hrefs[0]);
      unmount();
      await Promise.resolve();
      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toBe(hrefs[0] ?? "");
    } finally {
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
