import type { ReactNode } from "react";

import { StellaMark } from "@stll/ui/components/stella-mark";

export const AppHeader = ({
  action,
  subtitle,
  title,
}: {
  action?: ReactNode;
  subtitle?: string | undefined;
  title: string;
}) => (
  <header className="bg-card/95 border-border sticky top-0 z-10 flex items-center justify-between gap-3 border-b px-4 py-3">
    <div className="flex min-w-0 items-start gap-2.5">
      <span
        aria-hidden="true"
        className="bg-primary text-primary-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md"
      >
        <StellaMark className="size-4.5" />
      </span>
      <div className="min-w-0">
        <h1 className="truncate text-sm/5 font-medium">{title}</h1>
        {subtitle ? (
          <p className="text-muted-foreground text-xs/4.5">{subtitle}</p>
        ) : null}
      </div>
    </div>
    {action}
  </header>
);
