import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { DetailsGrid, DetailsItem } from "./details-grid";

describe("details fact sheets", () => {
  test("groups each label and value in a semantic description list", () => {
    const markup = renderToStaticMarkup(
      <DetailsGrid aria-label="Decision details">
        <DetailsItem label="Court">Supreme Court</DetailsItem>
        <DetailsItem label="Source">
          <a href="https://example.com">Published decision</a>
        </DetailsItem>
      </DetailsGrid>,
    );

    expect(markup).toContain('<dl class="');
    expect(markup).toContain('aria-label="Decision details"');
    expect(markup.match(/<dt\b/gu)).toHaveLength(2);
    expect(markup.match(/<dd\b/gu)).toHaveLength(2);
    expect(markup).toMatch(/<dt[^>]*>Court<\/dt><dd[^>]*>Supreme Court<\/dd>/u);
    expect(markup).toContain(
      '<a href="https://example.com">Published decision</a>',
    );
  });

  test("shares one label track across ordinary and full-width facts", () => {
    const markup = renderToStaticMarkup(
      <DetailsGrid>
        <DetailsItem label="Date">2026-10-05</DetailsItem>
        <DetailsItem label="ECLI" span="wide">
          ECLI:CZ:NS:2026:LONG_IDENTIFIER
        </DetailsItem>
      </DetailsGrid>,
    );
    const itemClasses = [
      ...markup.matchAll(/class="([^"]*)" data-slot="details-item"/gu),
    ].map((match) => match[1]);

    expect(itemClasses).toHaveLength(2);
    for (const className of itemClasses) {
      expect(className).toContain("grid-cols-[minmax(0,7rem)_minmax(0,1fr)]");
    }
    expect(itemClasses.at(0)).not.toContain("col-span-full");
    expect(itemClasses.at(1)).toContain("col-span-full");
  });

  test("chooses up to three pair columns from container width", () => {
    const markup = renderToStaticMarkup(<DetailsGrid />);

    expect(markup).toContain(
      'class="@container min-w-0 [contain-intrinsic-inline-size:20rem]"',
    );
    expect(markup).toContain(
      "grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))]",
    );
    expect(markup).toContain("@min-[64rem]:grid-cols-3");
  });

  test("preserves translated labels and inherited RTL direction without clipping values", () => {
    const markup = renderToStaticMarkup(
      <DetailsGrid dir="rtl">
        <DetailsItem label="المحكمة">المحكمة العليا</DetailsItem>
      </DetailsGrid>,
    );

    expect(markup).toContain('dir="rtl"');
    expect(markup).toContain("المحكمة");
    expect(markup).toContain("المحكمة العليا");
    expect(markup.match(/min-w-0[^"<>]*wrap-anywhere/gu)).toHaveLength(2);
    expect(markup).not.toContain("truncate");
  });

  test("a horizontal list aligns every label in one shared column", () => {
    const markup = renderToStaticMarkup(
      <DetailsGrid variant="list">
        <DetailsItem label="Account">ada@example.com</DetailsItem>
        <DetailsItem label="Organization">Analytical Engines</DetailsItem>
      </DetailsGrid>,
    );

    // No fact-sheet container: the list sizes to its host.
    expect(markup).not.toContain("details-grid-container");
    expect(markup).toContain("grid-cols-[auto_minmax(0,1fr)]");
    expect(markup.match(/grid-cols-subgrid/gu)).toHaveLength(2);
    expect(markup).not.toContain("uppercase");
    expect(markup).toMatch(
      /<dt[^>]*>Account<\/dt><dd[^>]*>ada@example.com<\/dd>/u,
    );
  });

  test("a vertical list puts each label above its value", () => {
    const markup = renderToStaticMarkup(
      <DetailsGrid orientation="vertical" variant="list">
        <DetailsItem label="Authorization server">
          https://auth.example.com
        </DetailsItem>
      </DetailsGrid>,
    );

    expect(markup).toContain('data-orientation="vertical"');
    expect(markup).toContain("flex-col");
    expect(markup.match(/<dt\b/gu)).toHaveLength(1);
    expect(markup).not.toContain("uppercase");
  });
});
