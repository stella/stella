import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { TruncatedText } from "@stll/ui/truncated-text";

type StatCardProps = {
  icon: ReactNode;
  label:
    | "common.workflows"
    | "workspaces.overview.nextDeadline"
    | "workspaces.overview.openTasks"
    | "workspaces.overview.timeThisWeek"
    | "workspaces.overview.totalDocuments";
  value: ReactNode;
  sublabel?: string | undefined;
  onClick?: () => void;
};

export const StatCard = ({
  icon,
  label,
  value,
  sublabel,
  onClick,
}: StatCardProps) => {
  const t = useTranslations();
  const content = (
    <>
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {icon}
        {t(label)}
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {sublabel && (
        <TruncatedText className="text-muted-foreground text-xs">
          {sublabel}
        </TruncatedText>
      )}
    </>
  );

  if (onClick) {
    return (
      // The clickable card draws the same card as the static one below and
      // only adds a hover tint, so a row of stats reads as one set.
      <Button className="block min-w-0" onClick={onClick} variant="plain">
        <span className="bg-card hover:bg-muted/50 flex h-full w-full min-w-0 flex-col items-start gap-1.5 rounded-lg border px-4 py-3">
          {content}
        </span>
      </Button>
    );
  }

  return (
    <div className="bg-card flex min-w-0 flex-col gap-1.5 rounded-lg border px-4 py-3">
      {content}
    </div>
  );
};
