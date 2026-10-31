import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

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
      <button
        className="bg-card hover:bg-muted/50 flex min-w-0 cursor-pointer flex-col items-start gap-1.5 rounded-lg border px-4 py-3 text-start"
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="bg-card flex min-w-0 flex-col gap-1.5 rounded-lg border px-4 py-3">
      {content}
    </div>
  );
};
