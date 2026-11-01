import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, mock, test } from "bun:test";

GlobalRegistrator.register();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { Button } = await import("./button");

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
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
  const labels = button.querySelectorAll('[data-slot="truncated-text"]');
  expect(labels).toHaveLength(1);
  expect(labels[0]?.textContent).toBe("Open Dunaj matter");
  // The glyph stays a sibling of the label, not inside it.
  expect(view.getByTestId("glyph").parentElement).toBe(button);
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
    expect(button.querySelector('[data-slot="truncated-text"]')).toBeNull();
    expect(button.classList.contains("max-w-full")).toBe(true);
  }
});
