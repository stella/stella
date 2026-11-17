import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const { act, cleanup, render } = await import("@testing-library/react");
const { Tooltip, TooltipPopup, TooltipTrigger } = await import("./tooltip");

afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

test("a label too long for one line pushes the shortcut onto the next", async () => {
  // The open popup's positioner settles asynchronously; awaiting it inside act
  // keeps that update from landing after the DOM is unregistered.
  await act(async () => {
    render(
      <Tooltip open>
        <TooltipTrigger>Search</TooltipTrigger>
        <TooltipPopup shortcut={["mod", "K"]}>Search everywhere</TooltipPopup>
      </Tooltip>,
    );
  });
  const row = document.querySelector('[data-slot="tooltip-shortcut-row"]');

  expect(row?.textContent).toBe("Search everywhereCtrl+K");
  expect(row?.classList.contains("flex-wrap")).toBe(true);
});
