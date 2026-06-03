import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { Separator } from "@stll/ui/components/separator";

import type { NumericFilter } from "@/routes/_protected.workspaces/-types";

type ItemsFilterPopoverProps = {
  value: NumericFilter | undefined;
  onChange: (value: NumericFilter | undefined) => void;
};

const parseField = (raw: string): number | undefined => {
  if (raw.trim() === "") {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
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

  return (
    <div className="flex w-56 flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">
            {t("workspaces.filters.items.gte")}
          </span>
          <Input
            inputMode="numeric"
            min={0}
            onChange={(e) =>
              onChange(build(parseField(e.target.value), value?.lte))
            }
            placeholder="0"
            size="sm"
            type="number"
            value={value?.gte ?? ""}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">
            {t("workspaces.filters.items.lte")}
          </span>
          <Input
            inputMode="numeric"
            min={0}
            onChange={(e) =>
              onChange(build(value?.gte, parseField(e.target.value)))
            }
            placeholder="∞"
            size="sm"
            type="number"
            value={value?.lte ?? ""}
          />
        </label>
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
