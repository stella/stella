import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Label } from "./label";

describe("Label muted variant", () => {
  test("a filter caption reads small and muted without restyling", () => {
    const markup = renderToStaticMarkup(
      <Label htmlFor="action" variant="muted">
        Action
      </Label>,
    );

    expect(markup).toContain('<label for="action"');
    expect(markup).toContain("text-muted-foreground");
    expect(markup).toContain("text-xs/4");
    expect(markup).not.toContain("text-foreground ");
  });
});
