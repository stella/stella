import type { ReactNode } from "react";

import { TableIcon } from "lucide-react";
import { useTranslations } from "use-intl";

type MobileTableOrientationGateProps = {
  children: ReactNode;
};

export const MobileTableOrientationGate = ({
  children,
}: MobileTableOrientationGateProps) => {
  const t = useTranslations();

  return (
    <>
      <div className="bg-background hidden min-h-64 flex-1 flex-col items-center justify-center gap-3 px-6 text-center max-md:portrait:flex">
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
      <div className="contents max-md:portrait:hidden">{children}</div>
    </>
  );
};
