import type { StatuteRowData } from "@/components/workspaces/table/types";

import { PublicLawTable } from "./public-law-table";
import type { PublicLawTableLayout } from "./public-law-table-layout.logic";

const layout: PublicLawTableLayout = {
  contentMode: "tight",
  hidden: [],
  order: [],
  pinned: [],
  sizing: {},
};

export const selectionRequiresActions = (
  rows: StatuteRowData[],
  selectedIds: string[],
) => (
  <PublicLawTable
    columns={[]}
    firstRowNumber={1}
    getRowId={(row) => row.statute.id}
    isLoading={false}
    layout={layout}
    onLayoutChange={() => undefined}
    rowHost={{ renderRow: () => null }}
    rows={rows}
    // @ts-expect-error A selectable public-law table must expose its consumer.
    selection={{ onSelectedIdsChange: () => undefined, selectedIds }}
    sorting={null}
  />
);
