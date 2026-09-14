import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Input } from "./input";

/** The class lists, in render order: the control wrapper, then its element. */
const classLists = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/gu)].map((match) => match[1] ?? "");

/**
 * Height utilities, counted with their variants stripped: a height restored
 * under `sm:` or `pointer-coarse:` overrides `h-full` in exactly the context
 * it applies to, which is the drift this guards against.
 */
const heightUtilities = (classes: string): string[] =>
  classes
    .split(" ")
    .map((token) => token.slice(token.lastIndexOf(":") + 1))
    .filter((token) => token.startsWith("h-"));

describe("Input", () => {
  test("keeps a coarse-pointer target", () => {
    const markup = renderToStaticMarkup(<Input />);

    expect(markup).toContain("pointer-coarse:min-h-11");
  });

  test("a height given to the control is the height of its element", () => {
    const [control = "", element = ""] = classLists(
      renderToStaticMarkup(<Input className="h-11" />),
    );

    expect(heightUtilities(control)).toContain("h-11");
    // The element states no height of its own, at any size or breakpoint:
    // that is what stops the text and the search icon centring on two
    // different boxes when a caller sizes the control.
    expect(heightUtilities(element)).toEqual(["h-full"]);
  });

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
