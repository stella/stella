import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { ToolbarIconAction } from "./toolbar-icon-action";

describe("ToolbarIconAction", () => {
  test("names the action without drawing its label as text", () => {
    const markup = renderToStaticMarkup(
      <ToolbarIconAction
        density="toolbar"
        icon={<svg data-testid="icon" />}
        label="Edit pages"
      />,
    );

    expect(markup).toContain('aria-label="Edit pages"');
    expect(markup).not.toContain(">Edit pages<");
    expect(markup).toContain('data-testid="icon"');
  });

  test("takes the icon size of the row it sits in", () => {
    const header = renderToStaticMarkup(
      <ToolbarIconAction density="header" icon={<svg />} label="Upload" />,
    );
    const toolbar = renderToStaticMarkup(
      <ToolbarIconAction density="toolbar" icon={<svg />} label="Upload" />,
    );

    // The Button size classes: icon-sm in the header, icon-xs in a toolbar.
    expect(header).toContain("size-8 sm:size-7");
    expect(toolbar).toContain("size-7 rounded-md");
  });
});
