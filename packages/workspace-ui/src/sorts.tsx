import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@stll/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";

import { PropertyIcon } from "./property-icon";
import type { PropertyIconType } from "./property-icon";

/** One sort a view carries. */
export type SortDescriptor = {
  propertyId: string;
  desc: boolean;
};

/** A property a view may sort by. */
export type SortableProperty = {
  id: string;
  name: string;
  type: PropertyIconType;
};

export type SortChipsLabels = {
  /** Accessible name of the "add a sort" trigger. */
  add: string;
  /** Accessible name of a chip's remove button. */
  remove: string;
};

export type SortChipsProps = {
  sorts: readonly SortDescriptor[];
  properties: readonly SortableProperty[];
  onUpdate: (sorts: SortDescriptor[]) => void;
  labels: SortChipsLabels;
};

/**
 * The view's sorts as chips, plus the menu that adds one.
 *
 * A sort is a property id and a direction; which properties can be sorted is
 * the caller's answer, so this reads nothing but the three fields a chip
 * draws.
 */
export const SortChips = ({
  sorts,
  properties,
  onUpdate,
  labels,
}: SortChipsProps) => (
  <>
    {sorts.map((sort) => {
      const property = properties.find(
        (candidate) => candidate.id === sort.propertyId,
      );

      if (!property) {
        return null;
      }

      return (
        <SortChip
          desc={sort.desc}
          key={sort.propertyId}
          labels={labels}
          onRemove={() => {
            onUpdate(
              sorts.filter(
                (candidate) => candidate.propertyId !== sort.propertyId,
              ),
            );
          }}
          onToggle={() => {
            onUpdate(
              sorts.map((candidate) =>
                candidate.propertyId === sort.propertyId
                  ? { ...candidate, desc: !candidate.desc }
                  : candidate,
              ),
            );
          }}
          propertyName={property.name}
          propertyType={property.type}
        />
      );
    })}
    <AddSortButton
      labels={labels}
      onAdd={(sort) => onUpdate([...sorts, sort])}
      properties={properties}
      sortedPropertyIds={new Set(sorts.map((sort) => sort.propertyId))}
    />
  </>
);

/**
 * What ascending means depends on what is being sorted: A→Z for words, 1→9 for
 * numbers, an arrow for dates. A type with no idiom falls back to the arrow
 * icon, which is why this returns null rather than a default string.
 */
export const sortDirectionHint = (
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
    case "person":
      return desc ? "Z→A" : "A→Z";
    case "int":
    case "money":
      return desc ? "9→1" : "1→9";
    case "date":
      return desc ? "↓" : "↑";
    default:
      return null;
  }
};

type SortChipProps = {
  propertyName: string;
  propertyType?: string | undefined;
  desc: boolean;
  onToggle: () => void;
  onRemove: () => void;
  labels: SortChipsLabels;
};

const SortChip = ({
  propertyName,
  propertyType,
  desc,
  onToggle,
  onRemove,
  labels,
}: SortChipProps) => {
  const SortIcon = desc ? ArrowDownIcon : ArrowUpIcon;
  const hint = sortDirectionHint(propertyType, desc);

  return (
    <div className="bg-muted/50 flex items-center rounded-md border">
      <Button onClick={onToggle} size="xs" variant="ghost">
        {!hint && <SortIcon />}
        {propertyName}
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </Button>
      <Button
        aria-label={labels.remove}
        onClick={onRemove}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  );
};

type AddSortButtonProps = {
  properties: readonly SortableProperty[];
  sortedPropertyIds: Set<string>;
  onAdd: (sort: SortDescriptor) => void;
  labels: SortChipsLabels;
};

const AddSortButton = ({
  properties,
  sortedPropertyIds,
  onAdd,
  labels,
}: AddSortButtonProps) => (
  <Menu>
    <MenuTrigger
      aria-label={labels.add}
      render={<Button size="icon-xs" variant="ghost" />}
    >
      <ArrowUpDownIcon />
    </MenuTrigger>
    <MenuPopup>
      {properties.map((property) => (
        <MenuItem
          disabled={sortedPropertyIds.has(property.id)}
          key={property.id}
          onClick={() => onAdd({ propertyId: property.id, desc: false })}
        >
          <PropertyIcon type={property.type} />
          {property.name}
        </MenuItem>
      ))}
    </MenuPopup>
  </Menu>
);
