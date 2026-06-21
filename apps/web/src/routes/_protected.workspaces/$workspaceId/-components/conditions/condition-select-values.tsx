import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { ConditionNode } from "@stll/conditions";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { cn } from "@stll/ui/lib/utils";

import type { FieldOption } from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-builder.logic";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import type { PropertyFacetCounts } from "@/routes/_protected.workspaces/$workspaceId/-queries/property-facets";
import { propertyFacetsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/property-facets";

/**
 * The data the value editors need to fetch facet counts: the workspace
 * and the view's active filter set. Undefined when the condition builder
 * runs outside an entity-faceting context (e.g. property auto-fill
 * rules), in which case options render without counts.
 */
export type FacetContext = {
  workspaceId: string;
  filters: ConditionNode[];
};

type FacetedSelectProps = {
  field: FieldOption;
  facetContext?: FacetContext | undefined;
  className?: string | undefined;
};

type SingleSelectValueProps = FacetedSelectProps & {
  value: string;
  onChange: (value: string) => void;
};

export const SingleSelectValue = ({
  field,
  facetContext,
  className,
  value,
  onChange,
}: SingleSelectValueProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const facets = usePropertyFacetCounts({ field, facetContext, open });
  const options = sortOptionsByCount(field.options ?? [], facets);
  const selected = options.find((option) => option.value === value);

  return (
    <Select
      onOpenChange={setOpen}
      onValueChange={(next) => {
        if (next !== null) {
          onChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger
        className={cn("h-7 min-h-0 w-auto min-w-28 text-xs", className)}
        size="sm"
      >
        <SelectValue placeholder={t("workspaces.fields.selectAValue")}>
          {() =>
            selected ? (
              <span className="flex items-center gap-1.5">
                {selected.color !== undefined && (
                  <SelectColorIcon color={selected.color} />
                )}
                {selected.label}
              </span>
            ) : (
              t("workspaces.fields.selectAValue")
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <OptionRow
              color={option.color}
              count={facets?.counts.get(option.value)}
              label={option.label}
              showCounts={facets !== undefined}
            />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

type MultiSelectValueProps = FacetedSelectProps & {
  value: string[];
  onChange: (value: string[]) => void;
};

export const MultiSelectValue = ({
  field,
  facetContext,
  className,
  value,
  onChange,
}: MultiSelectValueProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const facets = usePropertyFacetCounts({ field, facetContext, open });
  const options = sortOptionsByCount(field.options ?? [], facets);
  const label =
    value.length === 0
      ? t("workspaces.fields.selectValues")
      : value
          .map((v) => options.find((option) => option.value === v)?.label ?? v)
          .join(", ");

  return (
    <Select
      multiple
      onOpenChange={setOpen}
      onValueChange={(next) => onChange(next)}
      value={value}
    >
      <SelectTrigger
        className={cn("h-7 min-h-0 w-auto min-w-28 text-xs", className)}
        size="sm"
      >
        <SelectValue>{() => label}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <OptionRow
              color={option.color}
              count={facets?.counts.get(option.value)}
              label={option.label}
              showCounts={facets !== undefined}
            />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

type OptionRowProps = {
  label: string;
  color: string | undefined;
  count: number | undefined;
  showCounts: boolean;
};

const OptionRow = ({ label, color, count, showCounts }: OptionRowProps) => (
  <span className="flex w-full items-center gap-1.5">
    {color !== undefined && <SelectColorIcon color={color} />}
    <span className="flex-1 truncate">{label}</span>
    {showCounts && (
      <span className="text-muted-foreground tabular-nums">{count ?? 0}</span>
    )}
  </span>
);

type FacetOption = NonNullable<FieldOption["options"]>[number];

const sortOptionsByCount = (
  options: FacetOption[],
  facets: PropertyFacetCounts | undefined,
): FacetOption[] => {
  if (!facets) {
    return options;
  }
  return [...options].toSorted(
    (a, b) =>
      (facets.counts.get(b.value) ?? 0) - (facets.counts.get(a.value) ?? 0),
  );
};

const usePropertyFacetCounts = ({
  field,
  facetContext,
  open,
}: {
  field: FieldOption;
  facetContext: FacetContext | undefined;
  open: boolean;
}): PropertyFacetCounts | undefined => {
  const propertyId =
    field.operand.type === "property" ? field.operand.propertyId : null;
  const enabled = open && facetContext !== undefined && propertyId !== null;

  const { data } = useQuery({
    ...propertyFacetsOptions({
      workspaceId: facetContext?.workspaceId ?? "",
      propertyId: propertyId ?? "",
      filters: facetContext?.filters ?? [],
    }),
    enabled,
  });

  return data;
};
