import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  drainReactScheduler,
  unregisterDomEnvironment,
} from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, render } = await import("@testing-library/react");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { ClipboardRailDivider } =
  await import("../src/clipboard/ClipboardRailDivider");

afterEach(async () => {
  await act(async () => {
    await drainReactScheduler();
  });
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const { allResults, noGroupMatches } = defaultMessages.clipboard;

const renderDivider = (groupEmpty: boolean) =>
  render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <div role="list">
        <button data-clipboard-card-trigger="" type="button">
          Lease termination clause
        </button>
        <ClipboardRailDivider groupEmpty={groupEmpty} />
        <button data-clipboard-card-trigger="" type="button">
          Lease renewal draft
        </button>
      </div>
    </DesktopIntlProvider>,
  );

test("the divider is a vertical separator named All results", () => {
  const view = renderDivider(false);
  const divider = view.getByRole("separator", { name: allResults });
  expect(divider.getAttribute("aria-orientation")).toBe("vertical");
  // The label is drawn for sighted users and announced once, by the name.
  expect(view.getAllByRole("separator")).toHaveLength(1);
  const drawn = view.getAllByText(allResults);
  expect(drawn).toHaveLength(1);
  expect(drawn[0]?.getAttribute("aria-hidden")).toBe("true");
  expect(view.queryByText(noGroupMatches)).toBeNull();
});

test("the divider is never a focus stop between two cards", () => {
  const view = renderDivider(false);
  const divider = view.getByRole("separator", { name: allResults });
  expect(divider.hasAttribute("tabindex")).toBe(false);
  expect(divider.querySelector("button, a, input, [tabindex]")).toBeNull();
  const focusable = view.container.querySelectorAll(
    "button, a[href], input, [tabindex]:not([tabindex='-1'])",
  );
  expect([...focusable].map((element) => element.textContent)).toEqual([
    "Lease termination clause",
    "Lease renewal draft",
  ]);
});

test("a group without matches says so before the divider", () => {
  const view = renderDivider(true);
  const line = view.getByText(noGroupMatches);
  const divider = view.getByRole("separator", { name: allResults });
  const order = [
    ...view.container.querySelectorAll(
      "[data-clipboard-rail-empty-group], [role=separator]",
    ),
  ];
  expect(order).toEqual([line, divider]);
});
