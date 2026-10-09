import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(30_000);

const sourcePath = "apps/web/src/components/filter-example.tsx";
const pickerPair = `import { DatePickerPopover as Calendar } from "@/components/date-picker-popover";
const Filter = () => <div><label>{t("search.dateFrom")}<Calendar /></label><label>{t("search.dateTo")}<Calendar /></label></div>;`;

test("rejects hand-built date filter pairs including renamed picker imports", async () => {
  expect(
    await lintSingleRule("no-hand-built-date-range-filter", pickerPair, {
      sourcePath,
    }),
  ).toEqual([2]);
});

test("rejects paired native date inputs with From and To labels", async () => {
  expect(
    await lintSingleRule(
      "no-hand-built-date-range-filter",
      'const Filter = () => <div><label>Od<input type="date" /></label><label>Do<input type="date" /></label></div>;',
      { sourcePath },
    ),
  ).toEqual([1]);
});

test("accepts the shared range and unrelated single date pickers", async () => {
  expect(
    await lintSingleRule(
      "no-hand-built-date-range-filter",
      'import { DatePickerPopover as Calendar } from "@/components/date-picker-popover"; const Filter = () => <div><DateRangeFilter from={from} to={to} /><label>{t("search.dateFrom")}<Calendar /></label></div>;',
      { sourcePath },
    ),
  ).toEqual([]);
});

test("exempts record-validity forms rather than query filters", async () => {
  for (const form of [
    "routes/_protected.workspaces/$workspaceId/-components/billing/rate-management-dialog.tsx",
    "routes/_protected.settings/-components/organization/vat-rate-form.tsx",
  ]) {
    expect(
      await lintSingleRule("no-hand-built-date-range-filter", pickerPair, {
        sourcePath: `apps/web/src/${form}`,
      }),
    ).toEqual([]);
  }
});

test("rejects paired decision date pickers in MCP result apps", async () => {
  expect(
    await lintSingleRule(
      "no-hand-built-date-range-filter",
      pickerPair.replace(
        "@/components/date-picker-popover",
        "@stll/ui/date-picker-popover",
      ),
      { sourcePath: "apps/api/src/mcp/apps/case-law-results/app.tsx" },
    ),
  ).toEqual([2]);
});

test("the registered fixture reaches the reporting boundary", async () => {
  const fixturePath =
    ".oxlint-plugins/__fixtures__/no-hand-built-date-range-filter.fixture.tsx";
  const fixture = readFileSync(
    new URL(
      "../__fixtures__/no-hand-built-date-range-filter.fixture.tsx",
      import.meta.url,
    ),
    "utf-8",
  );
  const unsuppressed = fixture.replace(
    /\{\/\* oxlint-disable-next-line[^\n]+\*\/\}/u,
    "",
  );
  expect(unsuppressed).not.toBe(fixture);
  expect(
    await lintSingleRule("no-hand-built-date-range-filter", unsuppressed, {
      sourcePath: fixturePath,
    }),
  ).toEqual([14]);
  expect(
    await lintSingleRule("no-hand-built-date-range-filter", fixture, {
      sourcePath: fixturePath,
    }),
  ).toEqual([]);
});

test("keeps other plugin fixtures outside the app ownership boundary", async () => {
  expect(
    await lintSingleRule("no-hand-built-date-range-filter", pickerPair, {
      sourcePath: ".oxlint-plugins/__fixtures__/unrelated.fixture.tsx",
    }),
  ).toEqual([]);
});
