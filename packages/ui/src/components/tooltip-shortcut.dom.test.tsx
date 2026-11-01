import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();
const { cleanup, render } = await import("@testing-library/react");
const { Tooltip, TooltipPopup, TooltipTrigger } = await import("./tooltip");

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

test("a label too long for one line pushes the shortcut onto the next", () => {
  render(
    <Tooltip open>
      <TooltipTrigger>Search</TooltipTrigger>
      <TooltipPopup shortcut={["mod", "K"]}>Search everywhere</TooltipPopup>
    </Tooltip>,
  );
  const row = document.querySelector('[data-slot="tooltip-shortcut-row"]');

  expect(row?.textContent).toBe("Search everywhereCtrl+K");
  expect(row?.classList.contains("flex-wrap")).toBe(true);
});
