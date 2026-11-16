import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { cleanup, render, screen } = await import("@testing-library/react");
const { SidebarMatterGroups } = await import("@/components/app-sidebar");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const PINNED_LABEL = "Pinned";
const RECENT_LABEL = "Recent matters";
const recentItems = Array.from({ length: 5 }, (_, index) => {
  const label = `Recent matter ${index + 1}`;
  return <li key={index}>{label}</li>;
});

test("pinned matters size to their content above labelled recent matters", () => {
  render(
    <SidebarMatterGroups
      pinnedItems={[<li key="pinned">{PINNED_LABEL}</li>]}
      pinnedLabel={PINNED_LABEL}
      recentItems={recentItems}
      recentLabel={RECENT_LABEL}
    />,
  );

  const pinnedGroup = screen.getByRole("group", { name: "Pinned" });
  expect(pinnedGroup.classList.contains("flex-1")).toBe(false);
  expect(pinnedGroup.classList.contains("flex-none")).toBe(true);
  expect(screen.getByRole("group", { name: "Recent matters" })).not.toBeNull();
});

test("an empty pinned group is not rendered", () => {
  render(
    <SidebarMatterGroups
      pinnedItems={[]}
      pinnedLabel={PINNED_LABEL}
      recentItems={recentItems}
      recentLabel={RECENT_LABEL}
    />,
  );

  expect(screen.queryByRole("group", { name: "Pinned" })).toBeNull();
  expect(screen.getByRole("group", { name: "Recent matters" })).not.toBeNull();
});
