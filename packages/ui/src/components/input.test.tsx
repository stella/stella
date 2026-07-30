import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Input } from "./input";

describe("Input", () => {
  test("search inputs always render their search affordance", () => {
    const markup = renderToStaticMarkup(<Input type="search" />);

    expect(markup).toContain('data-slot="input-search-icon"');
    expect(markup.indexOf('data-slot="input-search-icon"')).toBeLessThan(
      markup.indexOf('data-slot="input"'),
    );
  });

  test("search affordances follow the resolved content direction", () => {
    const markup = renderToStaticMarkup(
      <Input type="search" value="legal matter" />,
    );

    expect(markup).toContain('data-slot="input-control" dir="auto"');
  });
});
