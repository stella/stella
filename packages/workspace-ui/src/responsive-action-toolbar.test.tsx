import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "./responsive-action-toolbar";

describe("ResponsiveActionToolbar", () => {
  test("keeps primary, secondary, and action slots in one responsive row", () => {
    const markup = renderToStaticMarkup(
      <ResponsiveActionToolbar aria-label="Workspace actions">
        <ResponsiveActionToolbarItem slot="primary">
          <input aria-label="Search" />
        </ResponsiveActionToolbarItem>
        <ResponsiveActionToolbarItem slot="secondary">
          <button type="button">Filter</button>
        </ResponsiveActionToolbarItem>
        <ResponsiveActionToolbarItem slot="action">
          <button type="button">More</button>
        </ResponsiveActionToolbarItem>
      </ResponsiveActionToolbar>,
    );

    expect(markup).toContain('aria-label="Workspace actions"');
    expect(markup).toContain("flex-nowrap");
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("scrollbar-width:none");
    expect(markup).toContain("-ms-overflow-style:none");
    expect(markup).toContain("webkit-scrollbar]:hidden");
    expect(markup).toContain("Search");
    expect(markup).toContain("Filter");
    expect(markup).toContain("More");
  });
});
