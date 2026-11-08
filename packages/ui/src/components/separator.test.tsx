import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { ResizeSeparator } from "./separator";

describe("ResizeSeparator", () => {
  test("is a focusable vertical separator carrying the width it controls", () => {
    const markup = renderToStaticMarkup(
      <ResizeSeparator
        keyboardStep={16}
        label="Resize filters"
        max={480}
        min={200}
        onResize={() => undefined}
        value={312.4}
      />,
    );

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-label="Resize filters"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('aria-valuemin="200"');
    expect(markup).toContain('aria-valuemax="480"');
    // Screen readers announce whole pixels.
    expect(markup).toContain('aria-valuenow="312"');
    expect(markup).toContain("cursor-col-resize");
  });

  test("lets the caller place it", () => {
    const markup = renderToStaticMarkup(
      <ResizeSeparator
        className="hidden md:block"
        keyboardStep={16}
        label="Resize preview"
        max={900}
        min={320}
        onResize={() => undefined}
        value={480}
      />,
    );

    expect(markup).toContain("hidden md:block");
  });
});
