import type { ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

/** The labels a stat card names its number with. */
export type StatCardLabel =
  | "common.workflows"
  | "workspaces.overview.nextDeadline"
  | "workspaces.overview.openTasks"
  | "workspaces.overview.timeThisWeek"
  | "workspaces.overview.totalDocuments";

/** A stat card's box: the static card, and the one a click opens from. */
export const STAT_CARD_BOX_CLASS =
  "bg-card flex min-w-0 flex-col gap-1.5 rounded-lg border px-4 py-3";

/** The clickable card's own box inside its button: the same card, tinted on hover. */
export const STAT_CARD_BUTTON_BOX_CLASS = cn(
  STAT_CARD_BOX_CLASS,
  "hover:bg-muted/50 h-full w-full items-start",
);

/** What every stat card holds, in its order: the label, the number, a note. */
export const StatCardContent = ({
  icon,
  label,
  sublabel,
  value,
}: {
  icon: ReactNode;
  label: ReactNode;
  value: ReactNode;
  sublabel?: ReactNode;
}) => (
  <>
    <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
      {icon}
      {label}
    </div>
    <div className="text-xl font-semibold tabular-nums">{value}</div>
    {sublabel}
  </>
);

/**
 * A stat card before its number has loaded: the card, its icon and label,
 * and a bar on the number's line.
 */
export const StatCardPending = ({
  icon,
  label,
}: {
  icon: ReactNode;
  label: StatCardLabel;
}) => (
  <div aria-hidden="true" className={STAT_CARD_BOX_CLASS}>
    <StatCardContent
      icon={icon}
      label={<PendingText barClassName="w-20" id={label} />}
      value={<FaceLabelPending className="w-12" />}
    />
  </div>
);
