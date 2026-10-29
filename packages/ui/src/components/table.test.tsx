import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

describe("Table", () => {
  test("wraps itself in a horizontal scroller unless the parent scrolls it", () => {
    const own = renderToStaticMarkup(<Table />);
    const parent = renderToStaticMarkup(<Table scroll="parent" />);

    expect(own).toContain('data-slot="table-container"');
    expect(parent).not.toContain('data-slot="table-container"');
    expect(parent.startsWith("<table")).toBe(true);
  });

  test("a card inset pads every column from the table's own data attribute", () => {
    const markup = renderToStaticMarkup(
      <Table inset="card">
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>1 May</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(markup).toContain('data-inset="card"');
    expect(markup.match(/in-data-\[inset=card\]:px-4/gu)).toHaveLength(2);
  });

  test("a sticky header sits on a muted band above the scrolling rows", () => {
    const sticky = renderToStaticMarkup(<TableHeader sticky />);
    const muted = renderToStaticMarkup(<TableHeader surface="muted" />);
    const plain = renderToStaticMarkup(<TableHeader />);

    expect(sticky).toContain("sticky top-0");
    expect(muted).toContain("bg-muted/50");
    expect(plain).not.toContain("bg-muted");
  });

  test("cells and rows carry tone, numerals and truncation as props", () => {
    const markup = renderToStaticMarkup(
      <TableRow tone="muted">
        <TableCell numeric>1,200.00</TableCell>
        <TableCell tone="muted" truncate>
          A long narrative
        </TableCell>
      </TableRow>,
    );

    expect(markup).toMatch(/<tr class="[^"]*text-muted-foreground/u);
    expect(markup).toContain("tabular-nums");
    expect(markup).toMatch(
      /<td class="[^"]*text-muted-foreground[^"]*truncate/u,
    );
  });

  test("a flush cell leaves the padding to the control that fills it", () => {
    const flush = renderToStaticMarkup(<TableCell flush />);
    const padded = renderToStaticMarkup(<TableCell />);

    expect(flush).toContain("p-0");
    expect(flush).not.toContain("p-2.5");
    expect(flush).not.toContain("in-data-[inset=card]:px-4");
    expect(padded).toContain("p-2.5");
  });

  test("a figures column aligns its head and cells to the end in tabular numerals", () => {
    const markup = renderToStaticMarkup(
      <TableRow>
        <TableHead align="end" numeric>
          Amount
        </TableHead>
        <TableCell align="end" numeric>
          1,200.00
        </TableCell>
      </TableRow>,
    );

    expect(markup).toMatch(/<th class="[^"]*text-end[^"]*tabular-nums/u);
    expect(markup).toMatch(/<td class="[^"]*text-end[^"]*tabular-nums/u);
    expect(markup).not.toMatch(/<th class="[^"]*text-start/u);
  });

  test("numeric alone sets a figures column to the end", () => {
    const markup = renderToStaticMarkup(
      <TableRow>
        <TableHead numeric>Hours</TableHead>
        <TableCell numeric>12.5</TableCell>
        <TableCell align="start" numeric>
          12.5
        </TableCell>
      </TableRow>,
    );

    expect(markup).toMatch(/<th class="[^"]*text-end[^"]*tabular-nums/u);
    expect(markup.match(/<td class="[^"]*text-end/gu)).toHaveLength(1);
    expect(markup).toMatch(/<td class="[^"]*text-start[^"]*tabular-nums/u);
  });

  test("a text cell keeps the reading edge without an alignment class", () => {
    const markup = renderToStaticMarkup(<TableCell>Novák</TableCell>);

    expect(markup).not.toContain("text-end");
    expect(markup).not.toContain("text-start");
  });

  test("a sortable head sorts through a design-system button", () => {
    const markup = renderToStaticMarkup(
      <SortableHead onSort={() => undefined} sortDirection="asc">
        Date
      </SortableHead>,
    );

    expect(markup).toContain('aria-sort="ascending"');
    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("-ms-3");
    expect(markup).not.toContain("flex-row-reverse");
  });

  test("a numeric sortable head puts its arrow before the label", () => {
    const markup = renderToStaticMarkup(
      <SortableHead numeric onSort={() => undefined} sortDirection={null}>
        Amount
      </SortableHead>,
    );

    expect(markup).toContain('aria-sort="none"');
    expect(markup).toMatch(/<th class="[^"]*text-end[^"]*tabular-nums/u);
    expect(markup).toContain("-me-3 flex-row-reverse");
  });
});
