import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { DecisionReaderProvider } = await import("./reader-adapters");
const { fakeReaderAdapters } = await import("../tests/reader-adapters");
const { HeadnoteBlock } = await import("./headnote-block");

afterEach(cleanup);
afterAll(async () => {
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
    const trigger = view.getByRole("button", { name: LABEL });
    expect(trigger.getAttribute("aria-expanded")).toBe(String(defaultOpen));
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe(String(!defaultOpen));
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe(String(defaultOpen));
  });

  test(`forced matches preserve the ${defaultOpen ? "closed" : "open"} reader choice`, () => {
    const view = render(fixture(defaultOpen));
    const trigger = view.getByRole("button", { name: LABEL });
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
  const trigger = view.getByRole("button", { name: LABEL });
  const passage = view.getByText(WORDS);
  view.rerender(fixture(false, true));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  view.rerender(fixture(false));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(view.getByText(WORDS)).toBe(passage);
  expect(passage.dataset["anchor"]).toBe("holding");
});

test("a decision key replacement resets the default without inheriting the last fold", () => {
  const view = render(fixture(false));
  fireEvent.click(view.getByRole("button", { name: LABEL }));
  view.rerender(fixture(false, false, "next-decision"));
  expect(
    view.getByRole("button", { name: LABEL }).getAttribute("aria-expanded"),
  ).toBe("false");
  view.rerender(fixture(true, false, "third-decision"));
  expect(
    view.getByRole("button", { name: LABEL }).getAttribute("aria-expanded"),
  ).toBe("true");
});

test("find-in-page reveals a closed source passage through the owning disclosure", async () => {
  const view = render(fixture(false));
  const passage = view.getByText(WORDS);
  const panel = passage.closest<HTMLElement>('[data-slot="collapsible-panel"]');
  expect(panel?.getAttribute("hidden")).toBe("until-found");
  await act(async () => {
    panel?.dispatchEvent(new Event("beforematch"));
  });
  expect(
    view.getByRole("button", { name: LABEL }).getAttribute("aria-expanded"),
  ).toBe("true");
  expect(passage.closest("[hidden]")).toBeNull();
});
