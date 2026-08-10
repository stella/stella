import { useTranslations } from "use-intl";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@stll/ui/components/input-group";
import { cn } from "@stll/ui/lib/utils";

import {
  combineDurationParts,
  parseDurationPart,
  splitDurationMinutes,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/duration-input.logic";

type DurationInputProps = {
  id: string;
  labelledBy: string;
  value: number;
  onChange: (minutes: number) => void;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
};

export const DurationInput = ({
  id,
  labelledBy,
  value,
  onChange,
  className,
  autoFocus,
  disabled,
}: DurationInputProps) => {
  const t = useTranslations("billing");
  const { hours, minutes } = splitDurationMinutes(value);

  const updateHours = (rawHours: string) => {
    const nextHours = parseDurationPart(rawHours);
    if (nextHours === null) {
      return;
    }
    onChange(combineDurationParts({ hours: nextHours, minutes }));
  };

  const updateMinutes = (rawMinutes: string) => {
    const nextMinutes = parseDurationPart(rawMinutes);
    if (nextMinutes === null) {
      return;
    }
    onChange(combineDurationParts({ hours, minutes: nextMinutes }));
  };

  return (
    <div
      aria-labelledby={labelledBy}
      className={cn("grid grid-cols-2 gap-2", className)}
      role="group"
    >
      <InputGroup>
        <InputGroupInput
          aria-label={t("hours")}
          autoFocus={autoFocus}
          className="tabular-nums"
          disabled={disabled}
          id={`${id}-hours`}
          inputMode="numeric"
          min={0}
          onChange={(event) => updateHours(event.currentTarget.value)}
          placeholder="0"
          step={1}
          type="number"
          value={hours === 0 ? "" : hours}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>{t("hours")}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      <InputGroup>
        <InputGroupInput
          aria-label={t("minutes")}
          className="tabular-nums"
          disabled={disabled}
          id={`${id}-minutes`}
          inputMode="numeric"
          max={59}
          min={0}
          onChange={(event) => updateMinutes(event.currentTarget.value)}
          placeholder="0"
          step={1}
          type="number"
          value={minutes === 0 ? "" : minutes}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>{t("minutes")}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
};
