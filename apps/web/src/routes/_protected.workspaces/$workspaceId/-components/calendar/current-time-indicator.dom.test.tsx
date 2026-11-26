import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { Temporal } from "@stll/time";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const { cleanup, render } = await import("@testing-library/react");
const { CurrentTimeIndicator } = await import("./current-time-indicator");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const dayPercent = () => {
  const now = Temporal.Now.zonedDateTimeISO();
  return `${((now.hour * 60 + now.minute) / 1440) * 100}%`;
};

test("the line stands at the current time of day from the first render", () => {
  const before = dayPercent();
  const { container } = render(<CurrentTimeIndicator />);
  const after = dayPercent();
  const line = container.firstElementChild;
  expect(line).toBeInstanceOf(HTMLElement);
  // A minute may turn over while it renders.
  expect([before, after]).toContain(
    line instanceof HTMLElement ? line.style.top : "",
  );
});
