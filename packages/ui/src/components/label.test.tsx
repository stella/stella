import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Label } from "./label";

describe("Label variants", () => {
  test("the default caption keeps its type and pairs with a control", () => {
    const markup = renderToStaticMarkup(<Label htmlFor="name">Name</Label>);

    expect(markup).toMatch(/^<label [^>]*for="name"/u);
    expect(markup).toContain("font-medium");
  });

  test("a choice row wraps its control and rings while it has focus", () => {
    const markup = renderToStaticMarkup(
      <Label variant="choice">
        <input name="court" type="radio" value="supreme" />
        Supreme Court
      </Label>,
    );

    expect(markup).toMatch(/^<label [^>]*><input /u);
    expect(markup).toContain("has-focus-visible:ring-2");
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("has-disabled:cursor-not-allowed");
    // A row in a list reads in body weight, unlike a caption.
    expect(markup).not.toContain("font-medium");
  });

  test("a choice card marks the chosen one", () => {
    const markup = renderToStaticMarkup(
      <Label variant="choice-card">
        <input name="mode" type="radio" value="copy" />
        Copy
      </Label>,
    );

    expect(markup).toContain("has-checked:border-primary");
    expect(markup).toContain("border");
    expect(markup).not.toContain("font-medium");
  });
});
