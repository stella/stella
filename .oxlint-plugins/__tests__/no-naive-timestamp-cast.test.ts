import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const NAIVE_SQL_TYPE = "timestamp";

const cases = [
  {
    title: "rejects a tagged SQL template with a zoneless cast",
    source: `const query = sql\`x::${NAIVE_SQL_TYPE}\`;`,
    lines: [1],
    sourcePath: "source.ts",
  },
  {
    title:
      "rejects ANSI SQL casts with precision and an explicit zoneless suffix",
    source: `const query = "CAST(x AS ${NAIVE_SQL_TYPE}(6) without time zone)";`,
    lines: [1],
    sourcePath: "source.ts",
  },
  {
    title: "allows explicit timezone sql`x::timestamptz`",
    source: "const query = sql`x::timestamptz`;",
    lines: [],
    sourcePath: "source.ts",
  },
  {
    title: "allows explicit timezone sql`x::timestamp(6) AT TIME ZONE 'UTC'`",
    source: "const query = sql`x::timestamp(6) AT TIME ZONE 'UTC'`;",
    lines: [],
    sourcePath: "source.ts",
  },
  {
    title: 'allows explicit timezone "CAST(x AS timestamp with time zone)"',
    source: 'const query = "CAST(x AS timestamp with time zone)";',
    lines: [],
    sourcePath: "source.ts",
  },
];

test.each(cases)(
  "no-naive-timestamp-cast: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (await runSingleRule("no-naive-timestamp-cast", source, { sourcePath }))
        .lines,
    ).toEqual(lines);
  },
);
