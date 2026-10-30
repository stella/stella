import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { DetailsGrid, DetailsItem } from "./details-grid";

describe("DetailsGrid orientation auto", () => {
  test("a list stacks in a narrow container and pairs up once there is room", () => {
    const markup = renderToStaticMarkup(
      <DetailsGrid orientation="auto" variant="list">
        <DetailsItem label="Account">ada@example.com</DetailsItem>
      </DetailsGrid>,
    );

    expect(markup).toContain('data-slot="details-grid-container"');
    expect(markup).toContain("@container");
    expect(markup).toContain("flex-col");
    expect(markup).toContain("@min-[24rem]:grid-cols-[auto_minmax(0,1fr)]");
    expect(markup).toContain("@min-[24rem]:grid-cols-subgrid");
  });

  test("a sheet pair stacks under 20rem and sits side by side above it", () => {
    const markup = renderToStaticMarkup(
      <DetailsGrid orientation="auto">
        <DetailsItem label="Court">Supreme Court</DetailsItem>
      </DetailsGrid>,
    );

    expect(markup).toContain(
      "@min-[20rem]:grid-cols-[minmax(0,7rem)_minmax(0,1fr)]",
    );
    expect(markup).not.toMatch(/ grid-cols-\[minmax\(0,7rem\)/u);
  });
});

describe("DetailsGrid labelWidth", () => {
  test("fixes a list's label column so grids line up", () => {
    const markup = renderToStaticMarkup(
      <DetailsGrid labelWidth="lg" variant="list">
        <DetailsItem label="Organization">Analytical Engines</DetailsItem>
      </DetailsGrid>,
    );

    expect(markup).toContain("grid-cols-[10rem_minmax(0,1fr)]");
    expect(markup).not.toContain("grid-cols-[auto_minmax(0,1fr)]");
  });

  test("widens or narrows a sheet's label column", () => {
    const markup = renderToStaticMarkup(
      <DetailsGrid labelWidth="sm">
        <DetailsItem label="Date">2026-10-05</DetailsItem>
      </DetailsGrid>,
    );

    expect(markup).toContain("grid-cols-[minmax(0,5rem)_minmax(0,1fr)]");
    expect(markup).not.toContain("grid-cols-[minmax(0,7rem)_minmax(0,1fr)]");
  });
});

describe("DetailsItem empty value", () => {
  test.each([null, undefined, "", "   "])("draws a dash for %p", (value) => {
    const markup = renderToStaticMarkup(
      <DetailsGrid>
        <DetailsItem label="Judge">{value}</DetailsItem>
      </DetailsGrid>,
    );

    expect(markup).toContain('data-slot="details-empty"');
    expect(markup).toContain("—");
  });

  test("keeps zero and real values", () => {
    const markup = renderToStaticMarkup(
      <DetailsGrid>
        <DetailsItem label="Hours">{0}</DetailsItem>
      </DetailsGrid>,
    );

    expect(markup).not.toContain("details-empty");
    expect(markup).toContain(">0<");
  });
});
