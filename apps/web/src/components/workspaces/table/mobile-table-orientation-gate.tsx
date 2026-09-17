import type { ReactNode } from "react";

import { TableIcon } from "lucide-react";
import { useTranslations } from "use-intl";

/**
 * The gate is for a phone held upright, not for a narrow window: it needs the
 * coarse pointer as well as the portrait viewport, so a desktop browser docked
 * to the side of a screen keeps its table.
 */
type MobileTableOrientationGateProps = {
  children: ReactNode;
};

export const MobileTableOrientationGate = ({
  children,
}: MobileTableOrientationGateProps) => {
  const t = useTranslations();

  return (
    <>
      <div className="bg-background hidden min-h-64 flex-1 flex-col items-center justify-center gap-3 px-6 text-center max-md:portrait:pointer-coarse:flex">
        <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-lg">
          <TableIcon className="size-5" />
        </div>
        <div className="max-w-72 space-y-1">
          <h2 className="text-sm font-medium">
            {t("workspaces.table.portraitTitle")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("workspaces.table.portraitDescription")}
          </p>
        </div>
      </div>
      <div className="contents max-md:portrait:pointer-coarse:hidden">
        {children}
      </div>
    </>
  );
};
