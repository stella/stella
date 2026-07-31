import { afterEach, expect, mock, test } from "bun:test";

import {
  cleanupPageGradients,
  initializePageGradients,
} from "./animated-gradient";

const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalGetComputedStyle = Object.getOwnPropertyDescriptor(
  globalThis,
  "getComputedStyle",
);
const originalIntersectionObserver = Object.getOwnPropertyDescriptor(
  globalThis,
  "IntersectionObserver",
);
const originalMutationObserver = Object.getOwnPropertyDescriptor(
  globalThis,
  "MutationObserver",
);

const restoreGlobal = (
  property:
    | "document"
    | "getComputedStyle"
    | "IntersectionObserver"
    | "MutationObserver"
    | "navigator"
    | "window",
  descriptor: PropertyDescriptor | undefined,
) => {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, property);
    return;
  }

  Object.defineProperty(globalThis, property, descriptor);
};

afterEach(() => {
  cleanupPageGradients();
  restoreGlobal("document", originalDocument);
  restoreGlobal("navigator", originalNavigator);
  restoreGlobal("window", originalWindow);
  restoreGlobal("getComputedStyle", originalGetComputedStyle);
  restoreGlobal("IntersectionObserver", originalIntersectionObserver);
  restoreGlobal("MutationObserver", originalMutationObserver);
});

test("iOS gradients animate one original SVG surface", () => {
  const cancel = mock(() => undefined);
  const pause = mock(() => undefined);
  const play = mock(() => undefined);
  const animate = mock((keyframes: unknown, options: unknown) => ({
    cancel,
    keyframes,
    options,
    pause,
    play,
  }));
  const image = {
    alt: "",
    animate,
    setAttribute: mock(() => undefined),
    src: "",
    style: {},
  };
  const renderedChildren: unknown[] = [];
  const root = {};
  let syncTransition: () => void = () => undefined;
  const removeEventListener = mock(() => undefined);
  const container = {
    addEventListener: (event: string, listener: () => void) => {
      if (event === "transitionend") {
        syncTransition = listener;
      }
    },
    dataset: { animatedGradient: "" },
    id: "gradient-light",
    isConnected: true,
    removeEventListener,
    replaceChildren: (...children: unknown[]) => {
      renderedChildren.push(...children);
    },
  };
  const visibilityDisconnect = mock(() => undefined);
  const themeDisconnect = mock(() => undefined);
  let opacity = "0";
  let syncTheme: () => void = () => undefined;

  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ opacity }),
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      disconnect = visibilityDisconnect;
      private readonly callback: (
        entries: { isIntersecting: boolean; target: Element }[],
      ) => void;

      constructor(
        callback: (
          entries: { isIntersecting: boolean; target: Element }[],
        ) => void,
      ) {
        this.callback = callback;
      }

      observe(target: Element) {
        this.callback([{ isIntersecting: true, target }]);
      }
    },
  });
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    value: class {
      disconnect = themeDisconnect;

      constructor(callback: () => void) {
        syncTheme = callback;
      }

      observe() {}
    },
  });

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      maxTouchPoints: 5,
      platform: "iPhone",
      userAgent: "iPhone",
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: () => ({ matches: false }),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => image,
      documentElement: root,
      querySelector: (selector: string) =>
        selector === "#gradient-light" ? container : null,
    },
  });

  initializePageGradients();

  expect(renderedChildren).toEqual([image]);
  expect(image.src).toBe("/images/gradients/hero-light.svg");
  expect(image.style).toMatchObject({ opacity: "0.38" });
  expect(animate).toHaveBeenCalledTimes(1);
  expect(pause).toHaveBeenCalledTimes(2);
  expect(play).toHaveBeenCalledTimes(0);

  opacity = "1";
  syncTheme();
  expect(play).toHaveBeenCalledTimes(1);

  opacity = "0";
  syncTransition();
  expect(pause).toHaveBeenCalledTimes(3);
  expect(animate.mock.calls.at(0)?.at(0)).toEqual({
    opacity: ["0.365", "0.38", "0.353", "0.38", "0.365"],
    transform: [
      "translate3d(-2%, -3%, 0) scale3d(1.11, 1.05, 1) rotate(-0.6deg)",
      "translate3d(2%, 1%, 0) scale3d(1.04, 1.12, 1) rotate(0.4deg)",
      "translate3d(-1%, 3%, 0) scale3d(1.13, 1.06, 1) rotate(-0.2deg)",
      "translate3d(3%, -2%, 0) scale3d(1.06, 1.13, 1) rotate(0.5deg)",
      "translate3d(-2%, -3%, 0) scale3d(1.11, 1.05, 1) rotate(-0.6deg)",
    ],
  });

  cleanupPageGradients();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(removeEventListener).toHaveBeenCalledTimes(1);
  expect(visibilityDisconnect).toHaveBeenCalledTimes(1);
  expect(themeDisconnect).toHaveBeenCalledTimes(1);
});
