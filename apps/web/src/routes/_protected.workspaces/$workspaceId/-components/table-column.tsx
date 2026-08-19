import type { TableColumnDef } from "@/components/workspaces/table/types";
import type { ConditionNode, WorkspaceProperty } from "@/lib/types";
import { PropertyPopover } from "@/routes/_protected.workspaces/$workspaceId/-components/property-popover";
import {
  PropertyCell,
  VerdictBadge,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table-column-cells";

type PropertyColumnOptions = {
  filters: ConditionNode[];
  property: WorkspaceProperty;
  // The graded position's verdict, when this ASK column has one. Rendered as a
  // chip beside the extracted value so the pair reads as a single
  // compliance-matrix cell. Undefined for plain columns and extractOnly ASKs.
  verdictProperty: WorkspaceProperty | undefined;
};

/**
 * How a property column draws. Its id, width and capabilities come from the
 * table schema; only the accessor and the two renderers are property-specific.
 */
export type PropertyColumnRender = Required<
  Pick<Extract<TableColumnDef, { accessorFn: unknown }>, "accessorFn">
> &
  Pick<TableColumnDef, "cell" | "header">;

export const getPropertyColumnRender = ({
  filters,
  property,
  verdictProperty,
}: PropertyColumnOptions): PropertyColumnRender => ({
  accessorFn: (row) => row.fields[property.id],
  header: (ctx) => (
    <PropertyPopover
      filters={filters}
      header={ctx.header}
      property={property}
    />
  ),
  cell: (props) => {
    const entity = props.row.original;
    if (!verdictProperty) {
      return <PropertyCell entity={entity} property={property} />;
    }
    // Verdict badge leads the cell so the extracted value keeps the remaining
    // width; the tier label + rationale live in the badge's hover card.
    const valuePending = entity.fields[property.id]?.content.type === "pending";
    return (
      <>
        <VerdictBadge
          entity={entity}
          loading={valuePending}
          verdictProperty={verdictProperty}
        />
        <PropertyCell entity={entity} property={property} />
      </>
    );
  },
});
