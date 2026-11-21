import { useId } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { NumberInput } from "@stll/ui/number-input";
import { Separator } from "@stll/ui/separator";

import type { NumericFilter } from "@/lib/workspaces/types";

type ItemsFilterPopoverProps = {
  value: NumericFilter | undefined;
  onChange: (value: NumericFilter | undefined) => void;
};

const parseField = (n: number | null): number | undefined => {
  if (n === null || !Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return Math.floor(n);
};

const build = (
  gte: number | undefined,
  lte: number | undefined,
): NumericFilter | undefined => {
  if (gte === undefined && lte === undefined) {
    return undefined;
  }
  const result: NumericFilter = {};
  if (gte !== undefined) {
    result.gte = gte;
  }
  if (lte !== undefined) {
    result.lte = lte;
  }
  return result;
};

export const ItemsFilterPopover = ({
  value,
  onChange,
}: ItemsFilterPopoverProps) => {
  const t = useTranslations();
  const gteId = useId();
  const lteId = useId();

  return (
    <div className="flex w-56 flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={gteId} variant="muted">
            {t("workspaces.filters.items.gte")}
          </Label>
          <NumberInput
            id={gteId}
            inputProps={{ placeholder: "0" }}
            min={0}
            onValueChange={(next) =>
              onChange(build(parseField(next), value?.lte))
            }
            size="sm"
            value={value?.gte ?? null}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={lteId} variant="muted">
            {t("workspaces.filters.items.lte")}
          </Label>
          <NumberInput
            id={lteId}
            inputProps={{ placeholder: "∞" }}
            min={0}
            onValueChange={(next) =>
              onChange(build(value?.gte, parseField(next)))
            }
            size="sm"
            value={value?.lte ?? null}
          />
        </div>
      </div>
      {value && (
        <>
          <Separator />
          <Button onClick={() => onChange(undefined)} size="xs" variant="ghost">
            <XIcon className="size-3.5" />
            {t("workspaces.filters.clear")}
          </Button>
        </>
      )}
    </div>
  );
};
