import { useState } from "react";

import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/components/input";
import { cn } from "@stll/ui/lib/utils";

import { formatMinutes } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-duration";

const BILLING_INCREMENT = 6;

const RE_HM = /^(?:(?<hours>\d+)h)?\s*(?:(?<mins>\d+)m)?$/iu;
const RE_COLON = /^(?<hours>\d+):(?<mins>\d{1,2})$/u;
const RE_DECIMAL = /^(?<value>\d+(?:\.\d+))$/u;
const RE_PLAIN = /^(?<value>\d+)$/u;

/**
 * Parses a user-entered duration string into minutes.
 * Accepts: "1.5" (hours), "1:30" (h:mm), "90m", "1h30m",
 * "1h", or a plain integer (interpreted as minutes).
 */
const parseDuration = (raw: string): number | null => {
  const s = raw.trim();
  if (s.length === 0) {
    return null;
  }

  // "1h30m" or "1h" or "30m"
  const hm = RE_HM.exec(s);
  if (hm?.groups && (hm.groups["hours"] || hm.groups["mins"])) {
    const hours = Number(hm.groups["hours"] ?? 0);
    const mins = Number(hm.groups["mins"] ?? 0);
    return hours * 60 + mins;
  }

  // "1:30" (h:mm)
  const colon = RE_COLON.exec(s);
  if (colon) {
    return (
      Number(colon.groups?.["hours"]) * 60 + Number(colon.groups?.["mins"])
    );
  }

  // Decimal hours: "1.5"
  const decimal = RE_DECIMAL.exec(s);
  if (decimal) {
    return Math.round(Number(decimal.groups?.["value"]) * 60);
  }

  // Plain integer: treated as minutes
  const plain = RE_PLAIN.exec(s);
  if (plain) {
    return Number(plain.groups?.["value"]);
  }

  return null;
};

const snapToIncrement = (minutes: number): number =>
  Math.ceil(minutes / BILLING_INCREMENT) * BILLING_INCREMENT;

/**
 * ASCII decimal hours for the editable input hint. The hint must round-trip
 * through parseDuration, which only accepts ASCII digits and a "." separator;
 * localized digits or a comma separator would be rejected on blur.
 */
const formatDecimalHoursInput = (minutes: number): string =>
  (minutes / 60).toFixed(2);

type DurationInputProps = {
  value: number;
  onChange: (minutes: number) => void;
  className?: string;
  autoFocus?: boolean;
};

export const DurationInput = ({
  value,
  onChange,
  className,
  autoFocus,
}: DurationInputProps) => {
  const t = useTranslations();
  const [displayValue, setDisplayValue] = useState(() => formatMinutes(value));
  const [isFocused, setIsFocused] = useState(false);

  const handleBlur = () => {
    setIsFocused(false);
    const parsed = parseDuration(displayValue);
    if (parsed !== null && parsed > 0) {
      const snapped = snapToIncrement(parsed);
      onChange(snapped);
      setDisplayValue(formatMinutes(snapped));
    } else {
      setDisplayValue(formatMinutes(value));
    }
  };

  const handleFocus = () => {
    setIsFocused(true);
  };

  return (
    <div className={cn("relative", className)}>
      {/* Structured numeric time (e.g. 0:30) has no strong directional
          character, so dir="auto" would inherit RTL; keep it LTR. */}
      <Input
        autoFocus={autoFocus}
        className="tabular-nums"
        dir="ltr"
        onBlur={handleBlur}
        onChange={(e) => setDisplayValue(e.currentTarget.value)}
        onFocus={handleFocus}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
        }}
        placeholder="0:00"
        value={displayValue}
      />
      {!isFocused && value > 0 && (
        <span className="text-muted-foreground pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 text-xs">
          {t("billing.decimalHours", {
            hours: formatDecimalHoursInput(value),
          })}
        </span>
      )}
    </div>
  );
};
