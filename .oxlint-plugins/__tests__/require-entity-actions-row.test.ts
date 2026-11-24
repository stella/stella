import { describe, expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const RULE = "require-entity-actions-row";
const lint = async (source: string): Promise<number[]> =>
  (await runSingleRule(RULE, source, { sourcePath: "table.tsx" })).lines;

describe(RULE, () => {
  test.concurrent(
    "flags standalone ellipsis Menu inside TableRow or ListItem",
    async () => {
      const source = [
        "<TableRow><TableCell>",
        "  <Menu><MenuTrigger><EllipsisVerticalIcon /></MenuTrigger></Menu>",
        "</TableCell></TableRow>;",
        "<ListItem>",
        "  <Menu><MenuTrigger><MoreHorizontalIcon /></MenuTrigger></Menu>",
        "</ListItem>;",
      ].join("\n");
      expect(await lint(source)).toEqual([2, 5]);
    },
  );

  test.concurrent(
    "allows EntityActionsButton inside rows and ellipsis Menu outside rows",
    async () => {
      const source = [
        "<EntityActions actions={[]} label='Actions' render={<TableRow />}><TableCell><EntityActionsButton /></TableCell></EntityActions>;",
        "<div><Menu><MenuTrigger><EllipsisVerticalIcon /></MenuTrigger></Menu></div>;",
      ].join("\n");
      expect(await lint(source)).toEqual([]);
    },
  );
});
