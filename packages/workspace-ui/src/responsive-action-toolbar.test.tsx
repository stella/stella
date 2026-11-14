import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "./responsive-action-toolbar";

describe("ResponsiveActionToolbar", () => {
  test("wraps its slots instead of scrolling them out of view", () => {
    const markup = renderToStaticMarkup(
      <ResponsiveActionToolbar aria-label="Workspace actions">
        <ResponsiveActionToolbarItem slot="primary">
          <input aria-label="Search" dir="ltr" />
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
    expect(markup).toContain("flex-wrap");
    expect(markup).not.toContain("overflow-x-auto");
    expect(markup).not.toContain("scrollbar");
    expect(markup).toContain("Search");
    expect(markup).toContain("Filter");
    expect(markup).toContain("More");
  });
});
