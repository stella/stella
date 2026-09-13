import type { RefObject } from "react";

import { InfoIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { PropertyIcon } from "@/components/workspaces/property-helpers";
import { entityPickerColumns } from "@/components/workspaces/table/entity-find.logic";
import type { EntityFindPickerColumn } from "@/components/workspaces/table/entity-find.logic";
import { TableFindBar } from "@/components/workspaces/table/table-find-bar";
import type { TableFindColumnRow } from "@/components/workspaces/table/table-find-bar";
import {
  useEntityFindPersistence,
  useEntityTableFind,
} from "@/components/workspaces/table/use-entity-table-find";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { useWorkspaceTableSchema } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-columns";
import { includesListItems } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters";

type ViewToolbarSearchProps = {
  /** The view pane, toolbar and grid: what a key press inside belongs to. */
  paneRef: RefObject<HTMLElement | null>;
  properties: WorkspaceProperty[];
  view: WorkspaceView<"table">;
  workspaceId: string;
};

/**
 * Find-in-table for a matter's rows: the shared bar, wired to the view's
 * property columns and to the find the table store keeps for that view.
 *
 * Only the wiring lives here. What the bar does — the shortcut, the chip, the
 * column picker, the floor on the term — is the shell's, so the public results
 * page meets the same control.
 */
export const ViewToolbarSearch = ({
  paneRef,
  properties,
  view,
  workspaceId,
}: ViewToolbarSearchProps) => {
  const t = useTranslations();
  const viewRef = { workspaceId, viewId: view.id };
  const { columns, selection, term } = useEntityTableFind({
    hasNameColumn: includesListItems(view.layout.filters),
    hiddenProperties: view.layout.hiddenProperties,
    properties,
    view: viewRef,
  });
  const find = useEntityFindPersistence(viewRef);
  // The picker also lists the metadata columns, disabled. They are read off the
  // rendered schema so the list cannot drift from the grid.
  const schema = useWorkspaceTableSchema({ properties, view });

  return (
    <TableFindBar
      appliedTerm={term}
      columns={entityPickerColumns({
        findColumns: columns,
        schemaColumns: schema.columns,
      }).map((column) =>
        pickerRow({
          column,
          metadataLabel: t("workspaces.views.findColumnMetadataNotSearchable"),
          propertyLabel: t("workspaces.views.findColumnNotSearchable"),
        }),
      )}
      find={find}
      paneRef={paneRef}
      selection={selection}
    />
  );
};

/** One picker row, drawn: the icon its column wears, and why it is out of reach. */
const pickerRow = ({
  column,
  metadataLabel,
  propertyLabel,
}: {
  column: EntityFindPickerColumn;
  metadataLabel: string;
  propertyLabel: string;
}): TableFindColumnRow => {
  if (column.kind === "metadata") {
    return {
      icon: <InfoIcon className="size-3.5 opacity-70" />,
      id: column.id,
      label: column.label,
      reason: metadataLabel,
      searchable: false,
    };
  }
  return {
    icon: <PropertyIcon type={column.contentType} />,
    id: column.id,
    label: column.label,
    ...(column.searchable
      ? { searchable: true }
      : { reason: propertyLabel, searchable: false }),
  };
};
