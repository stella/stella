import { act } from "react";
import { createRoot } from "react-dom/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { ScrollToTop } from "./scroll-to-top";

let previousActEnvironment: unknown;

beforeAll(() => {
  GlobalRegistrator.register();
  previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterAll(async () => {
  if (previousActEnvironment === undefined) {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  } else {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  }
  await unregisterDomEnvironment();
});

const scrollTo = (element: HTMLElement, top: number) => {
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    value: top,
  });
  element.dispatchEvent(new Event("scroll"));
};

test("the button shows past the threshold and takes the container back to the top", async () => {
  const container = document.createElement("div");
  const scrollContainer = document.createElement("div");
  document.body.append(container, scrollContainer);
  const scrollToMock = mock(() => undefined);
  scrollContainer.scrollTo = scrollToMock;
  // A container already scrolled past the threshold shows the button at once.
  scrollTo(scrollContainer, 300);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ScrollToTop
        label="Back to top"
        scrollContainerRef={{ current: scrollContainer }}
        threshold={120}
      />,
    );
  });
  const button = container.querySelector("button");
  try {
    expect(button?.className).toContain("opacity-100");

    await act(async () => scrollTo(scrollContainer, 40));
    expect(button?.className).toContain("opacity-0");

    await act(async () => scrollTo(scrollContainer, 500));
    expect(button?.className).toContain("opacity-100");

    await act(async () => button?.click());
    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    scrollContainer.remove();
  }
});
