import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { useFormatter, useRelativeTime } from "@/i18n/formatting-context";
import { formatFullTimestamp, MEDIUM_DATE_FORMAT } from "@/lib/relative-time";

type TimestampProps = {
  value: Date | string;
  format?: "medium" | "relative";
  className?: string;
};

/**
 * Canonical timestamp display: formats through the user's locale preferences,
 * aligns digits with `tabular-nums`, and always exposes the full timestamp on
 * hover/focus via the shared Tooltip.
 */
export const Timestamp = ({
  className,
  format = "medium",
  value,
}: TimestampProps) => {
  const formatter = useFormatter();
  const relativeTime = useRelativeTime();
  const display =
    format === "relative"
      ? relativeTime(value)
      : formatter.dateTime(new Date(value), MEDIUM_DATE_FORMAT);

  return (
    <Tooltip content={formatFullTimestamp(value)} render={<span />}>
      <span className={cn("tabular-nums", className)}>{display}</span>
    </Tooltip>
  );
};
