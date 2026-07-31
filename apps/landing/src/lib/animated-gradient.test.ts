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

const restoreGlobal = (
  property: "document" | "navigator" | "window",
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
});

test("iOS gradients animate one original SVG surface", () => {
  const cancel = mock(() => undefined);
  const animate = mock((keyframes: unknown, options: unknown) => ({
    cancel,
    keyframes,
    options,
  }));
  const image = {
    alt: "",
    animate,
    setAttribute: mock(() => undefined),
    src: "",
    style: {},
  };
  const renderedChildren: unknown[] = [];
  const container = {
    dataset: { animatedGradient: "" },
    id: "gradient-light",
    isConnected: true,
    replaceChildren: (...children: unknown[]) => {
      renderedChildren.push(...children);
    },
  };

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
      querySelector: (selector: string) =>
        selector === "#gradient-light" ? container : null,
    },
  });

  initializePageGradients();

  expect(renderedChildren).toEqual([image]);
  expect(image.src).toBe("/images/gradients/hero-light.svg");
  expect(animate).toHaveBeenCalledTimes(1);
  expect(animate.mock.calls.at(0)?.at(0)).toEqual({
    opacity: ["0.96", "1", "0.93", "1", "0.96"],
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
});
