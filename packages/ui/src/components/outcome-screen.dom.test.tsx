import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, jest, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { restoreRealTimers } from "@stll/property-testing/fake-timers";

GlobalRegistrator.register();
const { act, cleanup, render } = await import("@testing-library/react");
const { OutcomeScreen } = await import("./outcome-screen");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

// Runs well past the short wait a closing tab gets before it counts as open.
const passFallbackDeadline = () => {
  act(() => {
    jest.advanceTimersByTime(1000);
  });
};

test("announces the outcome as one status region headed by its title", () => {
  const view = render(
    <OutcomeScreen
      description="Return to stella to continue."
      note="You can close this tab."
      title="ChatGPT is connected"
      tone="success"
    />,
  );
  const region = view.getByRole("status");
  expect(region.querySelector("h1")?.textContent).toBe("ChatGPT is connected");
  expect(region.textContent).toContain("Return to stella to continue.");
  expect(region.textContent).toContain("You can close this tab.");
  expect(region.dataset["tone"]).toBe("success");
  // The glyph is decoration; the words carry the outcome.
  expect(
    region.querySelector("[data-slot=outcome-badge]")?.closest("[aria-hidden]"),
  ).not.toBeNull();
});

test("moves focus to the outcome heading once shown, so it is read out", () => {
  const before = document.createElement("button");
  document.body.append(before);
  before.focus();
  const view = render(
    <OutcomeScreen title="Invitation declined" tone="success" />,
  );
  const heading = view.getByRole("heading", { name: "Invitation declined" });
  expect(document.activeElement).toBe(heading);
  expect(heading.getAttribute("tabindex")).toBe("-1");
  before.remove();
});

test("a counterpart joins stella's tile through the connector; without one the badge sits on the tile", () => {
  const joined = render(
    <OutcomeScreen
      counterpart={<span data-testid="client-mark" />}
      title="Claude is connected"
      tone="success"
    />,
  );
  expect(joined.getAllByTestId("client-mark")).toHaveLength(1);
  expect(
    joined.container.querySelectorAll("[data-slot=outcome-tile]"),
  ).toHaveLength(2);
  expect(
    joined.container.querySelector("[data-slot=outcome-connector]"),
  ).not.toBeNull();
  cleanup();

  const alone = render(<OutcomeScreen title="Sign-in failed" tone="error" />);
  expect(
    alone.container.querySelectorAll("[data-slot=outcome-tile]"),
  ).toHaveLength(1);
  expect(
    alone.container.querySelector("[data-slot=outcome-connector]"),
  ).toBeNull();
  expect(
    alone.container.querySelector<HTMLElement>("[data-slot=outcome-badge]")
      ?.dataset["tone"],
  ).toBe("error");
});

test("a page owns the viewport; an embedded outcome leaves it to the layout", () => {
  const page = render(<OutcomeScreen title="Declined" tone="success" />);
  expect(page.container.querySelector("main [role=status]")).not.toBeNull();
  // The mark in the tile signs the page; nothing repeats it below.
  expect(
    page.container.querySelectorAll("svg[viewBox='0 0 40 41']"),
  ).toHaveLength(1);
  cleanup();
  const embedded = render(
    <OutcomeScreen surface="embedded" title="Declined" tone="success" />,
  );
  expect(embedded.container.querySelector("main")).toBeNull();
});

test("the facts sit on one surface, each value its own bidi run, and none is drawn when there are none", () => {
  const view = render(
    <OutcomeScreen
      details={[
        { label: "Account", value: "person@example.com" },
        { label: "Organization", value: "Harbrook & Partners" },
      ]}
      title="Signed in to stella"
      tone="success"
    />,
  );
  const surfaces = view.container.querySelectorAll(
    "[data-slot=outcome-details]",
  );
  expect(surfaces).toHaveLength(1);
  expect(surfaces[0]?.tagName).toBe("DL");
  expect(
    [...view.container.querySelectorAll("dt")].map((term) => term.textContent),
  ).toEqual(["Account", "Organization"]);
  expect(
    [...view.container.querySelectorAll("dd > bdi")].map(
      (value) => value.textContent,
    ),
  ).toEqual(["person@example.com", "Harbrook & Partners"]);
  cleanup();

  const empty = render(
    <OutcomeScreen details={[]} title="Signed in" tone="success" />,
  );
  expect(
    empty.container.querySelector("[data-slot=outcome-details]"),
  ).toBeNull();
});

test("a command to run is set as code that reads left to right", () => {
  const view = render(
    <OutcomeScreen
      command="stella auth login"
      title="Sign-in failed"
      tone="error"
    />,
  );
  const code = view.container.querySelector("code[data-slot=outcome-command]");
  expect(code?.textContent).toBe("stella auth login");
  expect(code?.getAttribute("dir")).toBe("ltr");
});

test("closing the tab tells the opener first, and falls back once when the browser keeps it", () => {
  const calls: string[] = [];
  const close = mock(() => {
    calls.push("close");
  });
  const original = window.close;
  window.close = close;
  jest.useFakeTimers();
  try {
    const view = render(
      <OutcomeScreen
        closeTab={{
          onBeforeClose: () => {
            calls.push("broadcast");
          },
          onStillOpen: () => {
            calls.push("still-open");
          },
        }}
        title="Integration connected"
        tone="success"
      />,
    );
    expect(calls).toEqual(["broadcast", "close"]);
    // A re-render does not close again.
    view.rerender(
      <OutcomeScreen
        closeTab={{
          onBeforeClose: () => {
            calls.push("broadcast-again");
          },
          onStillOpen: () => {
            calls.push("still-open");
          },
        }}
        title="Integration connected"
        tone="success"
      />,
    );
    expect(calls).toEqual(["broadcast", "close"]);
    passFallbackDeadline();
    expect(calls).toEqual(["broadcast", "close", "still-open"]);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    restoreRealTimers();
    window.close = original;
  }
});

test("a screen without closeTab never closes the tab", () => {
  const close = mock(() => undefined);
  const original = window.close;
  window.close = close;
  jest.useFakeTimers();
  try {
    render(<OutcomeScreen title="Your agent is connected" tone="success" />);
    passFallbackDeadline();
    expect(close).not.toHaveBeenCalled();
  } finally {
    restoreRealTimers();
    window.close = original;
  }
});
