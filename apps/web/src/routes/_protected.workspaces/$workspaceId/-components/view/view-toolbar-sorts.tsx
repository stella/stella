import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  XIcon,
} from "lucide-react";

import type { ViewLayout, WorkspaceProperty } from "@/lib/types";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";

type SortChipsProps = {
  sorts: ViewLayout["sorts"];
  properties: WorkspaceProperty[];
  onUpdate: (sorts: ViewLayout["sorts"]) => void;
};

export const SortChips = ({ sorts, properties, onUpdate }: SortChipsProps) => (
  <>
    {sorts.map((sort) => {
      const property = properties.find((p) => p.id === sort.propertyId);

      if (!property) {
        return null;
      }

      return (
        <SortChip
          desc={sort.desc}
          key={sort.propertyId}
          onRemove={() => {
            onUpdate(sorts.filter((s) => s.propertyId !== sort.propertyId));
          }}
          onToggle={() => {
            onUpdate(
              sorts.map((s) =>
                s.propertyId === sort.propertyId ? { ...s, desc: !s.desc } : s,
              ),
            );
          }}
          propertyName={property.name}
          propertyType={property.content.type}
        />
      );
    })}
    <AddSortButton
      onAdd={(sort) => onUpdate([...sorts, sort])}
      properties={properties}
      sortedPropertyIds={new Set(sorts.map((s) => s.propertyId))}
    />
  </>
);

type SortChipProps = {
  propertyName: string;
  propertyType?: string;
  desc: boolean;
  onToggle: () => void;
  onRemove: () => void;
};

const getSortChipLabel = (
  propertyType: string | undefined,
  desc: boolean,
): string | null => {
  if (!propertyType) {
    return null;
  }

  switch (propertyType) {
    case "text":
    case "single-select":
    case "multi-select":
    case "file":
      return desc ? "Z\u2192A" : "A\u2192Z";
    case "int":
      return desc ? "9\u21921" : "1\u21929";
    case "date":
      return desc ? "\u2193" : "\u2191";
    default:
      return null;
  }
};

const SortChip = ({
  propertyName,
  propertyType,
  desc,
  onToggle,
  onRemove,
}: SortChipProps) => {
  const SortIcon = desc ? ArrowDownIcon : ArrowUpIcon;
  const hint = getSortChipLabel(propertyType, desc);

  return (
    <div className="bg-muted/50 flex items-center rounded-md border">
      <Button onClick={onToggle} size="xs" variant="ghost">
        {!hint && <SortIcon />}
        {propertyName}
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </Button>
      <Button onClick={onRemove} size="icon-xs" variant="ghost">
        <XIcon />
      </Button>
    </div>
  );
};

type AddSortButtonProps = {
  properties: WorkspaceProperty[];
  sortedPropertyIds: Set<string>;
  onAdd: (sort: ViewLayout["sorts"][number]) => void;
};

const AddSortButton = ({
  properties,
  sortedPropertyIds,
  onAdd,
}: AddSortButtonProps) => (
  <Menu>
    <MenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
      <ArrowUpDownIcon />
    </MenuTrigger>
    <MenuPopup>
      {properties.map((property) => (
        <MenuItem
          disabled={sortedPropertyIds.has(property.id)}
          key={property.id}
          onClick={() =>
            onAdd({
              propertyId: property.id,
              desc: false,
            })
          }
        >
          <PropertyIcon type={property.content.type} />
          {property.name}
        </MenuItem>
      ))}
    </MenuPopup>
  </Menu>
);
