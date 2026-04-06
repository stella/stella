import { Link } from "@tanstack/react-router";

import { cn } from "@stella/ui/lib/utils";

type ClientGroupHeaderProps = {
  clientId: string;
  clientName: string;
  matterCount: number;
};

export const ClientGroupHeader = ({
  clientId,
  clientName,
  matterCount,
}: ClientGroupHeaderProps) => (
  <div
    className={cn(
      "sticky top-0 z-10 col-span-full",
      "flex items-center gap-2",
      "bg-background/95 border-b backdrop-blur-sm",
      "pt-4 pb-2 first:pt-0",
    )}
  >
    <h3 className="text-sm font-semibold">
      <Link
        className="hover:underline"
        params={{ contactId: clientId }}
        to="/contacts/$contactId"
      >
        {clientName}
      </Link>
    </h3>
    <span
      className={cn(
        "bg-muted rounded-full px-1.5 py-0.5",
        "text-muted-foreground text-[0.625rem] tabular-nums",
      )}
    >
      {matterCount}
    </span>
  </div>
);
