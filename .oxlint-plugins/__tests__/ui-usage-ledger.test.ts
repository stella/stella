import { describe, expect, test } from "bun:test";

import {
  readCommittedUiUsage,
  readUiUsage,
  UI_DRIFT_WRITE,
  UI_USAGE_LEDGER_PATH,
  usageCount,
  usageMismatches,
} from "../../scripts/ui-drift-ledgers.ts";

// `Button variant="plain"` is a click target whose look is its content; it
// is not a way to skip choosing a variant. A raw `<kbd>` draws a key cap that
// `@stll/ui/kbd` should draw. The ledger holds how many of each every file
// renders, so neither spreads without a reviewed change to a file the
// design-system owners hold.
const HOW_TO_UPDATE =
  `${UI_USAGE_LEDGER_PATH} holds, per file, how many \`Button variant="plain"\` ` +
  "and raw `<kbd>` it renders. A plain button is for a box-less target whose " +
  "look is its content (a card, a cell, a thumbnail); a styled action takes a " +
  "variant (DESIGN.md, Button Variants). If the change is deliberate, or a " +
  `count went down, run \`${UI_DRIFT_WRITE}\` and commit the ledger with it.`;

describe("ui usage ledger", () => {
  test("matches the plain buttons and raw key caps each file renders", () => {
    const errors = usageMismatches(readCommittedUiUsage(), readUiUsage());
    expect(errors, `${errors.join("\n")}\n\n${HOW_TO_UPDATE}`).toEqual([]);
  });
});

describe("usageCount", () => {
  test("counts a plain variant in every spelling and only there", () => {
    const source = [
      '<Button variant="plain" />',
      "<Button variant={'plain'} />",
      '<Button variant={open ? "plain" : "ghost"} />',
      '<Button variant={surface === "plain" ? "outline" : "ghost"} />',
      '<Button variant="ghost" />',
      'const surface = "plain";',
    ].join("\n");
    expect(usageCount("plain-button", source)).toBe(3);
  });

  test("counts raw key caps, not the component", () => {
    expect(
      usageCount("raw-kbd", "<kbd>K</kbd> <kbd className='x'>J</kbd> <Kbd />"),
    ).toBe(2);
  });
});

describe("usageMismatches", () => {
  const empty = { "plain-button": {}, "raw-kbd": {} };

  test("a rise and a fall both fail", () => {
    expect(
      usageMismatches(
        { ...empty, "plain-button": { "a.tsx": 1, "b.tsx": 2 } },
        { ...empty, "plain-button": { "a.tsx": 2, "b.tsx": 1 } },
      ),
    ).toEqual([
      "plain-button a.tsx: 2 in the file, 1 in the ledger (added)",
      "plain-button b.tsx: 1 in the file, 2 in the ledger (removed)",
    ]);
  });

  test("a file new to the ledger fails", () => {
    expect(
      usageMismatches(empty, { ...empty, "raw-kbd": { "c.tsx": 1 } }),
    ).toEqual(["raw-kbd c.tsx: 1 in the file, 0 in the ledger (added)"]);
  });
});
