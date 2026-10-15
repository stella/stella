import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { SquareMinusIcon } from "@stll/ui/icons";
import { PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { PropertyIcon } from "@/components/workspaces/property-helpers";
import { resolveOptionColor } from "@/components/workspaces/property-utils";
import { HighlightedText } from "@/components/workspaces/table/find-highlight";
import type { PropertyOptionColor } from "@/lib/api-contract";
import type { WorkspaceProperty } from "@/lib/types";

const isPropertyValid = (property: WorkspaceProperty) => {
  // Only AI columns can be "invalid" (an empty prompt extracts nothing).
  // Manual and system-computed verdict columns have no prompt to warn about.
  if (property.tool.type !== "ai-model") {
    return true;
  }

  return property.tool.prompt.trim().length > 0;
};

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
          render={
            <Button
              className="h-full w-full justify-start text-start"
              size="sm"
              variant="ghost"
            />
          }
          disabled={disabled}
        />
      }
    >
      <PropertyIcon
        className={cn(isValid ? "" : "text-warning")}
        type={property.content.type}
      />
      <span className="w-0 flex-1 truncate">
        <HighlightedText text={name} />
      </span>
    </Tooltip>
  );
};

type SelectColorIconProps = {
  color: PropertyOptionColor | undefined;
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
