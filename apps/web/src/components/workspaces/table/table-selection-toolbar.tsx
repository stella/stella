import type { ReactNode } from "react";

import { Button } from "@stll/ui/button";

type TableSelectionToolbarProps = {
  actions: ReactNode;
  clearLabel: string;
  label: string;
  onClear: () => void;
};

/** The one visible owner for actions that operate on selected table rows. */
export const TableSelectionToolbar = ({
  actions,
  clearLabel,
  label,
  onClear,
}: TableSelectionToolbarProps) => (
  <div className="bg-muted/50 flex flex-wrap items-center gap-2 border-b px-3 py-2">
    <span className="text-sm font-medium tabular-nums">{label}</span>
    <div className="ms-auto flex flex-wrap items-center gap-2">
      {actions}
      <Button onClick={onClear} size="sm" variant="ghost">
        {clearLabel}
      </Button>
    </div>
  </div>
);
