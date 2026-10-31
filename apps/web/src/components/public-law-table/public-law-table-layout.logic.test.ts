import { expect, test } from "bun:test";

import { applyPublicLawSizingChange } from "./public-law-table-layout.logic";

test("independent column resizes commute even when both tables publish the same original map", () => {
  const previous = { title: 120, date: 160 };
  const titleEdit = { ...previous, title: 220 };
  const dateEdit = { ...previous, date: 240 };
  for (const { first, second } of [
    { first: titleEdit, second: dateEdit },
    { first: dateEdit, second: titleEdit },
  ]) {
    const afterFirst = applyPublicLawSizingChange({
      previous,
      next: first,
      latest: previous,
    });
    const result = applyPublicLawSizingChange({
      previous,
      next: second,
      latest: afterFirst,
    });
    expect(result).toEqual({ title: 220, date: 240 });
  }
});

test("resetting a column preserves peer resizes and columns absent from the publishing table", () => {
  expect(
    applyPublicLawSizingChange({
      previous: { title: 120, date: 160 },
      next: { date: 160 },
      latest: { title: 220, date: 240, court: 180 },
    }),
  ).toEqual({ date: 240, court: 180 });
});
