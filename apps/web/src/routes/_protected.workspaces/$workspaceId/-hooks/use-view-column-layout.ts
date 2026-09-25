import type { WorkspaceView } from "@/lib/types";
import type { TableColumnLayout } from "@/lib/workspaces/column-layout";
import { useUpdateView } from "@/lib/workspaces/mutations/views";

type UseViewColumnLayoutInput = {
  workspaceId: string;
  view: WorkspaceView<"table">;
};

/**
 * A matter's column arrangement: read from the saved view, written back to
 * it, so everyone working the matter sees the same table.
 */
export const useViewColumnLayout = ({
  workspaceId,
  view,
}: UseViewColumnLayoutInput): TableColumnLayout => {
  const updateView = useUpdateView(workspaceId);

  return {
    hidden: view.layout.hiddenProperties,
    order: view.layout.columnOrder,
    pinned: view.layout.columnPinning,
    onChange: ({ hidden, order, pinned }) => {
      updateView.mutate({
        viewId: view.id,
        layout: {
          ...view.layout,
          ...(hidden === undefined ? {} : { hiddenProperties: [...hidden] }),
          ...(order === undefined ? {} : { columnOrder: [...order] }),
          ...(pinned === undefined ? {} : { columnPinning: [...pinned] }),
        },
      });
    },
  };
};
