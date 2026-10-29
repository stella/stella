import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, mock, test } from "bun:test";

GlobalRegistrator.register();
const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { Button } = await import("./button");

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

test("accessible-disabled styling preserves activation", () => {
  const onClick = mock(() => undefined);
  const onKeyDown = mock(() => undefined);
  render(
    <Button data-accessible-disabled="" onClick={onClick} onKeyDown={onKeyDown}>
      Configure
    </Button>,
  );

  const button = screen.getByRole("button", { name: "Configure" });
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
