import type { ComponentProps } from "react";

import { useTranslations } from "use-intl";

import type { PropertyContentType } from "@stll/api/types";
import { PropertyIcon } from "@stll/workspace-ui/property-icon";

import type { WorkspaceField } from "@/lib/types";

export { PropertyIcon } from "@stll/workspace-ui/property-icon";

type FieldTypeWithoutPending = Exclude<
  WorkspaceField["content"]["type"],
  "pending"
>;

type PropertyIconType = FieldTypeWithoutPending | PropertyContentType;

type PropertyHelperProps = {
  type: PropertyIconType;
  className?: string;
};

export const PropertyPopoverLabel = (props: ComponentProps<"span">) => (
  <span className="text-sm font-semibold" {...props} />
);

export const PropertyName = ({ type }: PropertyHelperProps) => {
  const t = useTranslations();

  const labelKeys = {
    text: t("workspaces.properties.text"),
    file: t("workspaces.properties.file"),
    error: t("common.error"),
    "single-select": t("workspaces.properties.singleSelect"),
    "multi-select": t("workspaces.properties.multiSelect"),
    unsupported: t("workspaces.properties.unsupported"),
    date: t("common.date"),
    int: t("workspaces.properties.int"),
    clip: t("workspaces.properties.clip"),
  } as const satisfies Record<FieldTypeWithoutPending, string>;

  return (
    <div className="flex items-center gap-1.5">
      <PropertyIcon type={type} />
      <span className="text-muted-foreground text-sm">{labelKeys[type]}</span>
    </div>
  );
};
