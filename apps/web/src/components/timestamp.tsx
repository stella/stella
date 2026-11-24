import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { useFormatter, useRelativeTime } from "@/i18n/formatting-context";
import {
  FULL_DATE_MEDIUM_TIME_FORMAT,
  MEDIUM_DATE_FORMAT,
} from "@/lib/relative-time";

type TimestampProps = {
  value: Date | string;
  format?: "medium" | "relative";
  className?: string;
  /** Optional wrapper around the formatted timestamp text (e.g. a translated phrase). */
  renderLabel?: (formatted: string) => ReactNode;
};

/**
 * Canonical timestamp display: formats through the user's locale preferences,
 * aligns digits with `tabular-nums`, and always exposes the full timestamp on
 * hover/focus via the shared Tooltip.
 */
export const Timestamp = ({
  className,
  format = "medium",
  renderLabel,
  value,
}: TimestampProps) => {
  const formatter = useFormatter();
  const relativeTime = useRelativeTime();
  const parsed = value instanceof Date ? value : new Date(value);
  const isValid = !Number.isNaN(parsed.getTime());
  const mediumDisplay = isValid
    ? formatter.dateTime(parsed, MEDIUM_DATE_FORMAT)
    : "";
  const display = format === "relative" ? relativeTime(value) : mediumDisplay;
  const fullTimestamp = isValid
    ? formatter.dateTime(parsed, FULL_DATE_MEDIUM_TIME_FORMAT)
    : "";

  return (
    <Tooltip content={fullTimestamp} render={<span />}>
      <span className={cn("tabular-nums", className)}>
        {renderLabel ? renderLabel(display) : display}
      </span>
    </Tooltip>
  );
};
