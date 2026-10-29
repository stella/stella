import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

const matrix = (density?: "compact") =>
  renderToStaticMarkup(
    <Table {...(density === undefined ? {} : { density })}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Item</TableHead>
          <TableHead scope="col">Contract</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableHead scope="row">Indemnity</TableHead>
          <TableCell>Present</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );

describe("Table density", () => {
  test("a data table is the default", () => {
    expect(matrix()).toContain('data-density="default"');
  });

  test("a compact table marks itself so its cells can tighten", () => {
    const markup = matrix("compact");
    expect(markup).toContain('data-density="compact"');
    expect(markup).toContain("in-data-[density=compact]:py-1.5");
    expect(markup).toContain("in-data-[density=compact]:whitespace-normal");
    // Rows hold no row-wide target, so they do not highlight.
    expect(markup).toContain("in-data-[density=compact]:hover:bg-transparent");
    // A row header reads as the row's first cell.
    expect(markup).toContain(
      "in-data-[density=compact]:[tbody_&amp;]:font-normal",
    );
    expect(markup.match(/<th\b/gu)).toHaveLength(3);
    expect(markup).toContain('scope="row"');
  });
});
