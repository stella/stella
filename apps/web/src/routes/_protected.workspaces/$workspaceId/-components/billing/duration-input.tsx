import { useCallback, useState } from "react";

import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/components/input";
import { cn } from "@stll/ui/lib/utils";

const BILLING_INCREMENT = 6;

const RE_HM = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/iu;
const RE_COLON = /^(\d+):(\d{1,2})$/u;
const RE_DECIMAL = /^(\d+(?:\.\d+))$/u;
const RE_PLAIN = /^(\d+)$/u;

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
  if (hm && (hm[1] || hm[2])) {
    const hours = Number(hm[1] ?? 0);
    const mins = Number(hm[2] ?? 0);
    return hours * 60 + mins;
  }

  // "1:30" (h:mm)
  const colon = RE_COLON.exec(s);
  if (colon) {
    return Number(colon[1]) * 60 + Number(colon[2]);
  }

  // Decimal hours: "1.5"
  const decimal = RE_DECIMAL.exec(s);
  if (decimal) {
    return Math.round(Number(decimal[1]) * 60);
  }

  // Plain integer: treated as minutes
  const plain = RE_PLAIN.exec(s);
  if (plain) {
    return Number(plain[1]);
  }

  return null;
};

const snapToIncrement = (minutes: number): number =>
  Math.ceil(minutes / BILLING_INCREMENT) * BILLING_INCREMENT;

export const formatMinutes = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) {
    return `${h}h ${m}m`;
  }
  if (h > 0) {
    return `${h}h`;
  }
  return `${m}m`;
};

export const formatDecimalHours = (minutes: number): string =>
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

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    const parsed = parseDuration(displayValue);
    if (parsed !== null && parsed > 0) {
      const snapped = snapToIncrement(parsed);
      onChange(snapped);
      setDisplayValue(formatMinutes(snapped));
    } else {
      setDisplayValue(formatMinutes(value));
    }
  }, [displayValue, onChange, value]);

  const handleFocus = useCallback(() => {
    setIsFocused(true);
  }, []);

  return (
    <div className={cn("relative", className)}>
      <Input
        autoFocus={autoFocus}
        className="tabular-nums"
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
            hours: formatDecimalHours(value),
          })}
        </span>
      )}
    </div>
  );
};
