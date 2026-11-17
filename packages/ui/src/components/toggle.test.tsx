import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Toggle } from "./toggle";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

describe("Toggle", () => {
  test("is a Button that reports its pressed state", () => {
    const markup = renderToStaticMarkup(
      <Toggle defaultPressed>Show resolved</Toggle>,
    );

    expect(markup).toContain('data-slot="toggle"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("data-pressed");
    // The button's selected treatment, not its hover fill.
    expect(markup).toContain("data-pressed:inset-ring");
  });

  test("an unpressed toggle is not marked", () => {
    const markup = renderToStaticMarkup(<Toggle>Show resolved</Toggle>);

    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain('data-pressed=""');
  });
});

describe("ToggleGroup", () => {
  test("lays its items in one tray and raises the chosen one", () => {
    const markup = renderToStaticMarkup(
      <ToggleGroup aria-label="Status" value={["open"]}>
        <ToggleGroupItem value="open">Open</ToggleGroupItem>
        <ToggleGroupItem value="closed">Closed</ToggleGroupItem>
      </ToggleGroup>,
    );

    expect(markup).toContain('data-slot="toggle-group"');
    expect(markup).toContain('role="group"');
    expect(markup.match(/data-slot="toggle-group-item"/gu)).toHaveLength(2);
    expect(markup.match(/aria-pressed="true"/gu)).toHaveLength(1);
    expect(markup).toContain("data-pressed:bg-background");
  });

  test("items take the group's size unless they name one", () => {
    const markup = renderToStaticMarkup(
      <ToggleGroup size="sm" value={[]}>
        <ToggleGroupItem value="a">A</ToggleGroupItem>
        <ToggleGroupItem aria-label="Grid" size="icon-xs" value="b">
          <span />
        </ToggleGroupItem>
      </ToggleGroup>,
    );

    expect(markup).toContain("h-8");
    expect(markup).toContain("gap-1.5");
    expect(markup).toContain("size-7");
  });
});
