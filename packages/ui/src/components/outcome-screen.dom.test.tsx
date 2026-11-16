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

test("an embedded outcome leaves the page and its wordmark to the layout", () => {
  const page = render(<OutcomeScreen title="Declined" tone="success" />);
  expect(page.container.querySelector("main footer svg")).not.toBeNull();
  cleanup();
  const embedded = render(
    <OutcomeScreen surface="embedded" title="Declined" tone="success" />,
  );
  expect(embedded.container.querySelector("main")).toBeNull();
  expect(embedded.container.querySelector("footer")).toBeNull();
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
