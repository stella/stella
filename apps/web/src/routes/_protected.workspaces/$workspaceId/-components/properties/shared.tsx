import { SquareMinusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { OptionColor, PropertyContent } from "@stll/api/types";
import { PopoverTrigger } from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import type { WorkspaceProperty } from "@/lib/types";
import {
  PropertyIcon,
  PropertyName,
  PropertyPopoverLabel,
} from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import {
  isPropertyValid,
  resolveOptionColor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/utils";

type PropertyPopoverTriggerProps = {
  disabled: boolean;
  property: WorkspaceProperty;
  name: string;
};

export const PropertyPopoverTrigger = ({
  disabled,
  property,
  name,
}: PropertyPopoverTriggerProps) => {
  const t = useTranslations();
  const isValid = isPropertyValid(property);

  return (
    <Tooltip
      align="start"
      content={
        isValid
          ? undefined
          : t("workspaces.properties.addPromptForBetterResults")
      }
      render={
        <PopoverTrigger
          className="hover:bg-accent flex h-full w-full items-center gap-1.5 ps-2 pe-3 text-start disabled:pointer-events-none disabled:opacity-64"
          disabled={disabled}
        />
      }
    >
      <PropertyIcon
        className={isValid ? "" : "text-warning"}
        type={property.content.type}
      />
      <span className="w-0 flex-1 truncate">{name}</span>
    </Tooltip>
  );
};

type PropertyPopoverTypeProps = {
  type: PropertyContent["type"];
};

export const PropertyPopoverType = ({ type }: PropertyPopoverTypeProps) => {
  const t = useTranslations();

  return (
    <div className="w-full px-2.5 pt-2">
      <div className="flex justify-between">
        <PropertyPopoverLabel>{t("common.type")}</PropertyPopoverLabel>
        <PropertyName type={type} />
      </div>
    </div>
  );
};

type SelectColorIconProps = {
  color: OptionColor | undefined;
  className?: string;
};

export const SelectColorIcon = ({ color, className }: SelectColorIconProps) => {
  if (!color) {
    return <SquareMinusIcon className={cn("size-4 shrink-0", className)} />;
  }

  return (
    <span
      className={cn("block size-4 shrink-0 rounded", className)}
      style={{ backgroundColor: resolveOptionColor(color).color }}
    />
  );
};
