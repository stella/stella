import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Text } from "./text";

describe("Text", () => {
  test("sets a role's size, colour and face", () => {
    const markup = renderToStaticMarkup(<Text variant="section">Recent</Text>);
    expect(markup).toContain('data-slot="text"');
    expect(markup).toContain('data-variant="section"');
    for (const name of ["text-xs", "uppercase", "text-muted-foreground"]) {
      expect(markup).toContain(name);
    }
    expect(markup).toContain("font-medium");
    expect(markup).not.toContain("text-foreground ");
  });

  test("defaults to body text in the foreground", () => {
    const markup = renderToStaticMarkup(<Text>plain</Text>);
    expect(markup).toContain("text-foreground");
    expect(markup).toContain("text-base");
  });
});
