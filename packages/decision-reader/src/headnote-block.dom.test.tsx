import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DecisionReaderProvider } = await import("./reader-adapters");
const { fakeReaderAdapters } = await import("../tests/reader-adapters");
const { HeadnoteBlock } = await import("./headnote-block");

const hadActEnvironment = Object.hasOwn(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const previousActEnvironment = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => void)[] = [];
const render = (node: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const rerender = (next: ReactNode) => {
    act(() => {
      root.render(next);
    });
  };
  rerender(node);
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return {
    rerender,
    getDisclosureButton: () => {
      const matches = [...container.querySelectorAll("button")].filter(
        (button) =>
          (button.getAttribute("aria-label") ?? button.textContent).trim() ===
          LABEL,
      );
      expect(matches).toHaveLength(1);
      const button = matches.at(0);
      if (button === undefined) {
        throw new Error("Missing named disclosure button");
      }
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("role") ?? "button").toBe("button");
      return button;
    },
    getSourcePassage: () => {
      const matches = [...container.querySelectorAll("p")].filter(
        (passage) => passage.textContent === WORDS,
      );
      expect(matches).toHaveLength(1);
      const passage = matches.at(0);
      if (passage === undefined) {
        throw new Error("Missing source passage");
      }
      return passage;
    },
  };
};
const fireEvent = {
  click: (target: HTMLElement) => {
    act(() => {
      target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
  },
};
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});
afterAll(async () => {
  if (hadActEnvironment) {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  } else {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
  await unregisterDomEnvironment();
});

const LABEL = "Court holding";
const WORDS = "The court's own anchored words.";
const fixture = (
  defaultOpen: boolean,
  forceOpen = false,
  key = "same-decision",
) => (
  <DecisionReaderProvider adapters={fakeReaderAdapters}>
    <HeadnoteBlock
      key={key}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      label={LABEL}
      origin={{ type: "court", chip: null }}
    >
      <p data-anchor="holding">{WORDS}</p>
    </HeadnoteBlock>
  </DecisionReaderProvider>
);

for (const defaultOpen of [false, true]) {
  test(`a ${defaultOpen ? "default-open" : "default-closed"} section follows reader choice`, () => {
    const view = render(fixture(defaultOpen));
    const trigger = view.getDisclosureButton();
    expect(trigger.getAttribute("aria-expanded")).toBe(String(defaultOpen));
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe(String(!defaultOpen));
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe(String(defaultOpen));
  });

  test(`forced matches preserve the ${defaultOpen ? "closed" : "open"} reader choice`, () => {
    const view = render(fixture(defaultOpen));
    const trigger = view.getDisclosureButton();
    // Pick the opposite state before find temporarily owns the opening.
    fireEvent.click(trigger);
    view.rerender(fixture(defaultOpen, true));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    view.rerender(fixture(defaultOpen));
    expect(trigger.getAttribute("aria-expanded")).toBe(String(!defaultOpen));
  });
}

test("a forced opening does not become a reader choice when the match clears", () => {
  const view = render(fixture(false));
  const trigger = view.getDisclosureButton();
  const passage = view.getSourcePassage();
  view.rerender(fixture(false, true));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  view.rerender(fixture(false));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(view.getSourcePassage()).toBe(passage);
  expect(passage.dataset["anchor"]).toBe("holding");
});

test("a decision key replacement resets the default without inheriting the last fold", () => {
  const view = render(fixture(false));
  fireEvent.click(view.getDisclosureButton());
  view.rerender(fixture(false, false, "next-decision"));
  expect(view.getDisclosureButton().getAttribute("aria-expanded")).toBe(
    "false",
  );
  view.rerender(fixture(true, false, "third-decision"));
  expect(view.getDisclosureButton().getAttribute("aria-expanded")).toBe("true");
});

test("find-in-page reveals a closed source passage through the owning disclosure", async () => {
  const view = render(fixture(false));
  const passage = view.getSourcePassage();
  const panel = passage.closest<HTMLElement>('[data-slot="collapsible-panel"]');
  expect(panel?.getAttribute("hidden")).toBe("until-found");
  await act(async () => {
    panel?.dispatchEvent(new Event("beforematch"));
  });
  expect(view.getDisclosureButton().getAttribute("aria-expanded")).toBe("true");
  expect(passage.closest("[hidden]")).toBeNull();
});
