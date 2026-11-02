import { Button } from "@stll/ui/button";
import { ArrowUpDownIcon, XIcon } from "@stll/ui/icons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";

import { sortDirectionOf } from "./column-sort";
import type { ColumnSortKind, SortDirectionLabels } from "./column-sort";
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
  /** What the property orders by, which decides what its chip calls each direction. */
  sortKind: ColumnSortKind;
};

export type SortChipsLabels = {
  /** Accessible name of the "add a sort" trigger. */
  addSort: string;
  /** Accessible name of a chip's remove button. */
  remove: string;
  /** What a chip calls its direction, per kind: the header menu's wording. */
  directions: SortDirectionLabels;
};

export type SortChipsProps = {
  sorts: readonly SortDescriptor[];
  properties: readonly SortableProperty[];
  onUpdate: (sorts: SortDescriptor[]) => void;
  labels: SortChipsLabels;
  /**
   * How many sorts the caller's backend accepts. The add-sort trigger is
   * disabled at the cap, so a view cannot be edited into a layout the server
   * would reject. Omitted means no cap.
   */
  maxSorts?: number | undefined;
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
  maxSorts,
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
          sortKind={property.sortKind}
        />
      );
    })}
    <AddSortButton
      disabled={maxSorts !== undefined && sorts.length >= maxSorts}
      labels={labels}
      onAdd={(sort) => onUpdate([...sorts, sort])}
      properties={properties}
      sortedPropertyIds={new Set(sorts.map((sort) => sort.propertyId))}
    />
  </>
);

type SortChipProps = {
  propertyName: string;
  sortKind: ColumnSortKind;
  desc: boolean;
  onToggle: () => void;
  onRemove: () => void;
  labels: SortChipsLabels;
};

const SortChip = ({
  propertyName,
  sortKind,
  desc,
  onToggle,
  onRemove,
  labels,
}: SortChipProps) => (
  <div className="bg-muted/50 flex items-center rounded-md border">
    <Button onClick={onToggle} size="xs" variant="ghost">
      {propertyName}
      <span className="text-muted-foreground">
        {labels.directions[sortKind][sortDirectionOf(desc)]}
      </span>
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

type AddSortButtonProps = {
  properties: readonly SortableProperty[];
  sortedPropertyIds: Set<string>;
  onAdd: (sort: SortDescriptor) => void;
  labels: SortChipsLabels;
  disabled: boolean;
};

const AddSortButton = ({
  properties,
  sortedPropertyIds,
  onAdd,
  labels,
  disabled,
}: AddSortButtonProps) => (
  <Menu>
    <MenuTrigger
      aria-label={labels.addSort}
      disabled={disabled}
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
