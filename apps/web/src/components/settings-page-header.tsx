import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

type SettingsPageHeaderProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

export const SettingsPageHeader = ({
  title,
  description,
  action,
}: SettingsPageHeaderProps) => (
  <header
    className={cn(
      "flex flex-wrap items-start justify-between gap-3",
      action !== undefined && "bg-background sticky top-0 z-10 py-2",
    )}
  >
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <h1 className="text-xl font-semibold">{title}</h1>
      {description && (
        <p className="text-muted-foreground text-sm">{description}</p>
      )}
    </div>
    {action}
  </header>
);
