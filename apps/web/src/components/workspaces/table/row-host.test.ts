import { describe, expect, expectTypeOf, test } from "bun:test";

import type {
  TableRowHost,
  TableRowRenderInput,
} from "@/components/workspaces/table/row-host";
import type {
  DecisionRowData,
  TableRowData,
  TableTreeNode,
} from "@/components/workspaces/table/types";
import type { EntityKind } from "@/lib/types";

/**
 * The row union discriminates on `kind`, and a host is typed by the kind it
 * serves. Those two properties are what keep an entity behaviour out of a
 * decision row's reach, and both are compile-time: these assertions fail by
 * refusing to typecheck, not by throwing.
 */
describe("the row host of one kind cannot serve another", () => {
  test("a decision row is not an entity row", () => {
    expectTypeOf<DecisionRowData>().not.toExtend<TableTreeNode>();
    expectTypeOf<TableTreeNode>().not.toExtend<DecisionRowData>();
    expectTypeOf<DecisionRowData>().toExtend<TableRowData>();
  });

  test("no entity kind claims the decision discriminator", () => {
    // `kind` can only discriminate the union while "decision" is not one of
    // the entity kinds; adding it upstream would silently merge the branches.
    expectTypeOf<EntityKind>().not.toExtend<"decision">();
  });

  test("an entity host draws entity rows only", () => {
    // Both aliases default to the entity row, which is what keeps a matter
    // table's own code reading unchanged.
    expectTypeOf<
      TableRowRenderInput<DecisionRowData>
    >().not.toExtend<TableRowRenderInput>();
    expectTypeOf<
      Parameters<TableRowHost["renderRow"]>[0]
    >().toEqualTypeOf<TableRowRenderInput>();
  });

  test("a collapsed-row span is asked of the host's own row kind", () => {
    type EntitySpan = NonNullable<TableRowHost["collapsedRowSpan"]>;

    expectTypeOf<Parameters<EntitySpan>[0]>().toEqualTypeOf<TableTreeNode>();
    expectTypeOf<DecisionRowData>().not.toExtend<Parameters<EntitySpan>[0]>();
  });

  test("a host declines a behaviour its rows do not have", () => {
    // `renderRow` is the only behaviour every kind owes the shell; a kind
    // whose rows never collapse, never survive a cross-section select-all, or
    // add nothing beside the grid simply omits those.
    const decisionHost: TableRowHost<DecisionRowData> = {
      renderRow: () => null,
    };

    expect(decisionHost.collapsedRowSpan).toBeUndefined();
    expect(decisionHost.bottomRow).toBeUndefined();
  });
});
