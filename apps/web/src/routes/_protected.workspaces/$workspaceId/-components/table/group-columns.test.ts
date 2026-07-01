import { describe, expect, test } from "bun:test";

import type { WorkspaceProperty } from "@/lib/types";
import {
  buildDocTypeGateLabels,
  selectGroupColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/group-columns";
import type { TableColumnDef } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

const property = ({
  id,
  tool,
}: Pick<WorkspaceProperty, "id" | "tool">): WorkspaceProperty => ({
  id,
  workspaceId: "workspace-1",
  name: id,
  status: "fresh",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  content: { version: 1, type: "text" },
  tool,
});

const column = (id: string): TableColumnDef => ({
  id,
  accessorFn: () => null,
});

describe("document-type grouped columns", () => {
  test("uses manual-input dependency gates when selecting group columns", () => {
    const classifierPropertyId = "property-document-type";
    const manualScoped = property({
      id: "property-playbook-manual",
      tool: {
        version: 1,
        type: "manual-input",
        dependencies: [
          {
            dependsOnPropertyId: classifierPropertyId,
            condition: {
              type: "compare",
              left: { type: "property", propertyId: classifierPropertyId },
              op: "eq",
              right: { type: "literal", value: "NDA" },
            },
          },
        ],
      },
    });
    const ungated = property({
      id: "property-title",
      tool: { version: 1, type: "manual-input" },
    });

    const gateLabelsByColumnId = buildDocTypeGateLabels({
      properties: [manualScoped, ungated],
      classifierPropertyId,
    });

    expect(
      selectGroupColumns({
        columns: [column(manualScoped.id), column(ungated.id)],
        gateLabelsByColumnId,
        groupValue: "MSA",
      }).map((selected) => selected.id),
    ).toEqual([ungated.id]);
    expect(
      selectGroupColumns({
        columns: [column(manualScoped.id), column(ungated.id)],
        gateLabelsByColumnId,
        groupValue: "NDA",
      }).map((selected) => selected.id),
    ).toEqual([manualScoped.id, ungated.id]);
  });
});
