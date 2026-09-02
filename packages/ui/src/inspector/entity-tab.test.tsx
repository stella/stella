import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { entityTabGlyph, InspectorEntityTab } from "./entity-tab";

// The tooltip trigger's own `data-slot="tooltip-trigger"` wins over the
// wrapped `InspectorRailTab`'s `data-slot="inspector-rail-tab"`, so this
// reads the class list off the (single) rendered `<button>` instead of
// keying off a slot name.
const railTabClasses = (markup: string) => {
  const match = /<button[^>]*>/u.exec(markup);
  const classAttribute = /class="([^"]*)"/u.exec(match?.[0] ?? "");
  return classAttribute?.[1]?.split(/\s+/u) ?? [];
};

describe("InspectorEntityTab", () => {
  test("an inactive tab shows the glyph, not the icon", () => {
    const markup = renderToStaticMarkup(
      <InspectorEntityTab
        active={false}
        glyph="CON"
        icon={<span data-testid="entity-icon">icon-content</span>}
        label="contract.docx"
      />,
    );

    expect(markup).toContain("CON");
    expect(markup).not.toContain("icon-content");
  });

  test("an active tab shows the icon, not the glyph", () => {
    const markup = renderToStaticMarkup(
      <InspectorEntityTab
        active
        glyph="CON"
        icon={<span data-testid="entity-icon">icon-content</span>}
        label="contract.docx"
      />,
    );

    expect(markup).toContain("icon-content");
    expect(markup).not.toContain(">CON<");
  });

  test("with no glyph, an inactive tab still renders the icon, dimmed", () => {
    const markup = renderToStaticMarkup(
      <InspectorEntityTab
        active={false}
        icon={<span data-testid="entity-icon">icon-content</span>}
        label="Draft contract"
      />,
    );

    expect(markup).toContain("icon-content");
    expect(markup).toContain("opacity-70");
  });

  test("with no glyph, an active tab renders the icon undimmed", () => {
    const markup = renderToStaticMarkup(
      <InspectorEntityTab
        active
        icon={<span data-testid="entity-icon">icon-content</span>}
        label="Draft contract"
      />,
    );

    expect(markup).toContain("icon-content");
    expect(markup).not.toContain("opacity-70");
  });

  test("active sets the rail tab's spine affordance", () => {
    const inactiveMarkup = renderToStaticMarkup(
      <InspectorEntityTab
        active={false}
        glyph="CON"
        icon={<span>icon</span>}
        label="contract.docx"
      />,
    );
    const activeMarkup = renderToStaticMarkup(
      <InspectorEntityTab
        active
        glyph="CON"
        icon={<span>icon</span>}
        label="contract.docx"
      />,
    );

    expect(railTabClasses(inactiveMarkup)).not.toContain("before:bg-primary");
    expect(railTabClasses(activeMarkup)).toEqual(
      expect.arrayContaining(["before:bg-primary", "before:absolute"]),
    );
    expect(activeMarkup).toContain('data-active=""');
  });

  test("the tooltip carries the full label", () => {
    const markup = renderToStaticMarkup(
      <InspectorEntityTab
        active={false}
        glyph="CON"
        icon={<span>icon</span>}
        label="contract.docx"
      />,
    );

    expect(markup).toContain("contract.docx");
    expect(markup).toContain('aria-label="contract.docx"');
  });
});

describe("entityTabGlyph", () => {
  test("drops the extension and uppercases the stem", () => {
    expect(entityTabGlyph("contract.docx")).toBe("con");
  });

  test("keeps a short name as-is, uppercased", () => {
    expect(entityTabGlyph("ab")).toBe("ab");
  });

  test("a name with no extension uses the whole stem", () => {
    expect(entityTabGlyph("readme")).toBe("rea");
  });

  test("a leading dot (dotfile) has no extension to drop", () => {
    expect(entityTabGlyph(".gitignore")).toBe("");
  });

  test("honours a custom length", () => {
    expect(entityTabGlyph("contract.docx", 5)).toBe("contr");
  });
});
