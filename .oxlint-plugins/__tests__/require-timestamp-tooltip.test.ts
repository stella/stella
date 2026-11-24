import { describe, expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const RULE = "require-timestamp-tooltip";
const lint = async (source: string): Promise<number[]> =>
  (await runSingleRule(RULE, source, { sourcePath: "table.tsx" })).lines;

describe(RULE, () => {
  test.concurrent(
    "flags bare dateTime and relativeTime inside TableCell and ListItem",
    async () => {
      const source = [
        "<TableCell>",
        "  {formatter.dateTime(createdAt)}",
        "</TableCell>;",
        "<ListItem>",
        "  {formatRelativeTime(createdAt)}",
        "</ListItem>;",
        "<TableCellFace>",
        "  {relativeTime(createdAt)}",
        "</TableCellFace>;",
      ].join("\n");
      expect(await lint(source)).toEqual([2, 5, 8]);
    },
  );

  test.concurrent(
    "allows Timestamp, Tooltip-wrapped dates, and attribute values",
    async () => {
      const source = [
        "<TableCell><Timestamp value={createdAt} /></TableCell>;",
        "<TableCell><Tooltip content={formatFullTimestamp(createdAt)} render={<span />}>{formatter.dateTime(createdAt)}</Tooltip></TableCell>;",
        "<TableCell><span aria-label={formatter.dateTime(createdAt)}>x</span></TableCell>;",
      ].join("\n");
      expect(await lint(source)).toEqual([]);
    },
  );
});
