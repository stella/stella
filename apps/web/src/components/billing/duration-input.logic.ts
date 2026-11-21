import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { parseLocaleDecimal } from "@stll/money";

export type DurationParts = {
  hours: number;
  minutes: number;
};

export const splitDurationMinutes = (totalMinutes: number): DurationParts => ({
  hours: Math.floor(totalMinutes / 60),
  minutes: totalMinutes % 60,
});

export const combineDurationParts = ({
  hours,
  minutes,
}: DurationParts): number => hours * 60 + minutes;

export const parseDurationPart = (
  value: string,
  locale = "en",
): number | null => {
  if (value.length === 0) {
    return 0;
  }

  const normalized = parseLocaleDecimal({
    amount: value,
    locale,
    maximumFractionDigits: 0,
  });
  return normalized.isErr()
    ? null
    : parseIntegerToken(normalized.value, { sign: "unsigned" }).unwrapOr(null);
};
