import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

type SettingsPageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
};

/** A settings page's heading and its one line, with an optional action. */
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
      {description !== undefined && description !== "" && (
        <p className="text-muted-foreground text-sm">{description}</p>
      )}
    </div>
    {action}
  </header>
);

/**
 * The heading in a pending phase: the same header with its title and line
 * through `PendingText`, so the heading that loads keeps its box.
 */
export const SettingsPageHeaderPending = ({
  action,
  description,
  title,
}: {
  title: PendingTextKey;
  description?: PendingTextKey | undefined;
  action?: ReactNode;
}) => (
  <SettingsPageHeader
    action={action}
    description={
      description === undefined ? undefined : (
        <PendingText barClassName="w-80 max-w-full" id={description} />
      )
    }
    title={<PendingText barClassName="w-32" id={title} />}
  />
);
