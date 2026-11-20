import type { ReactNode } from "react";

import { TableIcon } from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";

/**
 * The gate is for a phone held upright, not for a narrow window: it needs the
 * coarse pointer as well as the portrait viewport, so a desktop browser docked
 * to the side of a screen keeps its table. Its words go through
 * `PendingText`, so a table's loading view draws the same gate.
 */
type MobileTableOrientationGateProps = {
  children: ReactNode;
};

export const MobileTableOrientationGate = ({
  children,
}: MobileTableOrientationGateProps) => (
  <>
    <div className="bg-background hidden min-h-64 flex-1 flex-col items-center justify-center gap-3 px-6 text-center max-md:portrait:pointer-coarse:flex">
      <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-lg">
        <TableIcon className="size-5" />
      </div>
      <div className="max-w-72 space-y-1">
        <h2 className="text-sm font-medium">
          <PendingText
            barClassName="w-40"
            id="workspaces.table.portraitTitle"
          />
        </h2>
        <p className="text-muted-foreground text-sm">
          <PendingText
            barClassName="w-56"
            id="workspaces.table.portraitDescription"
          />
        </p>
      </div>
    </div>
    <div className="contents max-md:portrait:pointer-coarse:hidden">
      {children}
    </div>
  </>
);
