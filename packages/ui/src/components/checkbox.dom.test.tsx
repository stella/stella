import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { useState } = await import("react");
const { Checkbox } = await import("./checkbox");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

for (const firstLine of ["text", "control"] as const) {
  test(`a ${firstLine} cell owns one named control and input in inherited RTL`, () => {
    let changes = 0;
    const Cell = () => {
      const [checked, setChecked] = useState(false);
      return (
        <div dir="rtl">
          <Checkbox
            appearance="cell"
            checked={checked}
            firstLine={firstLine}
            rowLabel="4"
            name="selection"
            onCheckedChange={(next) => {
              changes += 1;
              setChecked(next);
            }}
          />
        </div>
      );
    };
    const view = render(<Cell />);
    const control = view.getByRole("checkbox", { name: "4" });
    expect(control.tagName).toBe("BUTTON");
    expect(control.getAttribute("type")).toBe("button");
    expect(control.closest('[dir="rtl"]')).not.toBeNull();
    expect(
      view.container.querySelectorAll('input[type="checkbox"]'),
    ).toHaveLength(1);
    expect(view.container.querySelectorAll('[role="checkbox"]')).toHaveLength(
      1,
    );
    const label = control.querySelector('[data-slot="checkbox-cell-label"]');
    expect(
      label?.classList.contains(firstLine === "text" ? "h-5" : "h-7"),
    ).toBe(true);
    fireEvent.click(control);
    expect(changes).toBe(1);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(label?.classList.contains("opacity-0")).toBe(true);
    fireEvent.click(control);
    expect(changes).toBe(2);
    expect(control.getAttribute("aria-checked")).toBe("false");
  });
}

test("mixed cells retain their visible label and optional accessible name", () => {
  const view = render(
    <Checkbox
      appearance="cell"
      checked={false}
      indeterminate
      firstLine="text"
      rowLabel="1"
      aria-label="Select group"
      onCheckedChange={() => undefined}
    />,
  );
  const control = view.getByRole("checkbox", { name: "Select group" });
  expect(control.getAttribute("aria-checked")).toBe("mixed");
  expect(
    control.querySelector('[data-slot="checkbox-cell-label"]')?.textContent,
  ).toBe("1");
  expect(
    control.querySelector<HTMLElement>('[data-slot="checkbox-indicator"]')
      ?.dataset["indeterminate"],
  ).toBe("");
});

test("a disabled cell cannot change selection", () => {
  let changes = 0;
  const view = render(
    <Checkbox
      appearance="cell"
      checked={false}
      disabled
      firstLine="control"
      rowLabel="2"
      onCheckedChange={() => {
        changes += 1;
      }}
    />,
  );
  const control = view.getByRole("checkbox", { name: "2" });
  expect(control).toHaveProperty("disabled", true);
  fireEvent.click(control);
  expect(changes).toBe(0);
});

test("default appearance preserves primitive rendering, input, and uncontrolled state", () => {
  const view = render(
    <Checkbox
      aria-label="Default"
      name="default-selection"
      defaultChecked
      className="ml-2"
    />,
  );
  const control = view.getByRole("checkbox", { name: "Default" });
  expect(control.tagName).toBe("SPAN");
  expect(control.dataset["slot"]).toBe("checkbox");
  expect(control.classList.contains("ml-2")).toBe(true);
  expect(control.classList.contains("border-input")).toBe(true);
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(
    view.container.querySelectorAll('input[type="checkbox"]'),
  ).toHaveLength(1);
  fireEvent.click(control);
  expect(control.getAttribute("aria-checked")).toBe("false");
});
