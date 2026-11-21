import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { Button } = await import("./button");
const { SplitButton } = await import("./split-button");

afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

test("accessible-disabled styling preserves activation", () => {
  const onClick = mock(() => undefined);
  const onKeyDown = mock(() => undefined);
  // Queried through this render's own result: `screen` stays bound to the
  // DOM of whichever test file loaded Testing Library first.
  const view = render(
    <Button data-accessible-disabled="" onClick={onClick} onKeyDown={onKeyDown}>
      Configure
    </Button>,
  );

  const button = view.getByRole("button", { name: "Configure" });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.classList.contains("opacity-64")).toBe(true);
  expect(button.classList.contains("cursor-not-allowed")).toBe(true);
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  fireEvent.keyDown(button, { key: "Enter" });
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(onKeyDown).toHaveBeenCalledTimes(1);
});

test("a text label is one run cut to the button's width", () => {
  const matter = "Dunaj";
  const view = render(
    <Button>
      <svg aria-hidden="true" data-testid="glyph" />
      Open {matter} matter
    </Button>,
  );

  const button = view.getByRole("button", { name: "Open Dunaj matter" });
  expect(button.classList.contains("max-w-full")).toBe(true);
  const labels = button.querySelectorAll('[data-slot="button-label"]');
  expect(labels).toHaveLength(1);
  expect(labels[0]?.textContent).toBe("Open Dunaj matter");
  // The glyph stays a sibling of the label, not inside it.
  expect(view.getByTestId("glyph").parentElement).toBe(button);
});

const OpenMatter = ({ withGlyph }: { withGlyph: boolean }) => (
  <Button>
    Open {withGlyph && <svg aria-hidden="true" />}
    {null} matter
  </Button>
);

test("children that render nothing do not split a label", () => {
  const view = render(<OpenMatter withGlyph={false} />);

  const button = view.getByRole("button", { name: "Open matter" });
  const labels = button.querySelectorAll('[data-slot="button-label"]');
  expect(labels).toHaveLength(1);
  expect(labels[0]?.textContent).toBe("Open  matter");
});

test("labels that wrap, sit in a sentence or lay out their own content are not cut", () => {
  const view = render(
    <>
      <Button layout="wrap">Wrapping label</Button>
      <Button size="inline">Inline label</Button>
      <Button variant="link">Link label</Button>
      <Button variant="plain">Plain label</Button>
      <Button aria-label="Icon label" size="icon">
        <svg aria-hidden="true" />
      </Button>
    </>,
  );

  for (const name of [
    "Wrapping label",
    "Inline label",
    "Link label",
    "Plain label",
    "Icon label",
  ]) {
    const button = view.getByRole("button", { name });
    expect(button.querySelector('[data-slot="button-label"]')).toBeNull();
    expect(button.classList.contains("max-w-full")).toBe(true);
  }
});

test("focus stays on a button as its disabled reason appears and clears", () => {
  const action = (disabled: boolean) => (
    <Button
      disabled={disabled}
      disabledReason={disabled ? "Saving changes…" : undefined}
    >
      Save changes
    </Button>
  );
  const view = render(action(false));
  const button = view.getByRole("button", { name: "Save changes" });
  button.focus();
  for (const disabled of [true, false]) {
    view.rerender(action(disabled));
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe(disabled ? "true" : null);
  }
});

test("the split primary keeps focus as its disabled reason appears and clears", () => {
  const action = (reason: string | undefined) => (
    <SplitButton
      menu={null}
      menuLabel="More create options"
      onPrimaryClick={() => undefined}
      primaryDisabledReason={reason}
    >
      Create document
    </SplitButton>
  );
  const view = render(action(undefined));
  const button = view.getByRole("button", { name: "Create document" });
  button.focus();
  for (const reason of ["A document is being created.", undefined]) {
    view.rerender(action(reason));
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe(reason ? "true" : null);
  }
});

test("a disabled reason composes with descriptions without remounting the button", () => {
  const action = (
    disabled: boolean,
    rich: boolean,
    renderHelp = "render-help",
  ) => (
    <>
      <span id="button-help">This changes your account.</span>
      <span id="render-help">Only on this device.</span>
      <span id="different-help">Use the managed account.</span>
      <Button
        aria-describedby="button-help"
        disabled={disabled}
        disabledReason={
          rich ? (
            <span id="formatted-reason">
              Wait for <strong>verification</strong>
            </span>
          ) : (
            "Saving changes."
          )
        }
        render={<button type="button" aria-describedby={renderHelp} />}
      >
        Save
      </Button>
    </>
  );
  const view = render(action(false, false));
  const button = view.getByRole("button", { name: "Save" });
  button.focus();

  view.rerender(action(true, false));
  expect(
    view.getByRole("button", {
      name: "Save",
      description:
        "This changes your account. Only on this device. Saving changes.",
    }),
  ).toBe(button);
  expect(document.activeElement).toBe(button);

  view.rerender(action(true, true));
  expect(
    view.getByRole("button", {
      name: "Save",
      description:
        "This changes your account. Only on this device. Wait for verification",
    }),
  ).toBe(button);
  expect(document.querySelectorAll("#formatted-reason")).toHaveLength(1);
  expect(document.activeElement).toBe(button);

  view.rerender(action(true, true, "different-help"));
  expect(
    view.getByRole("button", {
      name: "Save",
      description:
        "This changes your account. Use the managed account. Wait for verification",
    }),
  ).toBe(button);
  expect(document.activeElement).toBe(button);

  view.rerender(action(false, true, "different-help"));
  expect(button.getAttribute("aria-describedby")).toBe("different-help");
  expect(document.querySelector("#formatted-reason")).toBeNull();
  expect(document.activeElement).toBe(button);
});
