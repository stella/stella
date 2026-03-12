import type { PropsWithChildren, ReactNode } from "react";

import { FilterIcon, XIcon } from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";

import type { ViewFilterCondition, WorkspaceProperty } from "@/lib/types";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";

type FilterChipsProps = {
  filters: ViewFilterCondition[];
  properties: WorkspaceProperty[];
  onUpdate: (filters: ViewFilterCondition[]) => void;
};

export const FilterChips = ({
  filters,
  properties,
  onUpdate,
}: FilterChipsProps) => {
  const handleChange = (id: string, updated: ViewFilterCondition) => {
    onUpdate(filters.map((f) => (f.id === id ? updated : f)));
  };

  const handleRemove = (id: string) => {
    onUpdate(filters.filter((f) => f.id !== id));
  };

  return (
    <>
      {filters.map((filter) =>
        filter.field === "kind" ? (
          <KindFilterChip
            filter={filter}
            key={filter.id}
            onChange={(updated) => handleChange(filter.id, updated)}
            onRemove={() => handleRemove(filter.id)}
          />
        ) : (
          <PropertyFilterChip
            filter={filter}
            key={filter.id}
            onChange={(updated) => handleChange(filter.id, updated)}
            onRemove={() => handleRemove(filter.id)}
            properties={properties}
          />
        ),
      )}
      <AddFilterButton
        hasKindFilter={filters.some((f) => f.field === "kind")}
        onAdd={(filter) => onUpdate([...filters, filter])}
        properties={properties}
      />
    </>
  );
};

type AddFilterButtonProps = {
  properties: WorkspaceProperty[];
  onAdd: (filter: ViewFilterCondition) => void;
  hasKindFilter?: boolean;
};

const AddFilterButton = ({
  properties,
  onAdd,
  hasKindFilter,
}: AddFilterButtonProps) => {
  const t = useTranslations();

  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
        <FilterIcon />
      </MenuTrigger>
      <MenuPopup>
        <MenuItem
          disabled={hasKindFilter}
          onClick={() =>
            onAdd({
              id: nanoid(),
              field: "kind",
              op: "in",
              value: [],
            })
          }
        >
          {t("common.kind")}
        </MenuItem>
        {properties.map((prop) => (
          <MenuItem
            key={prop.id}
            onClick={() =>
              onAdd({
                id: nanoid(),
                field: "property",
                propertyId: prop.id,
                op: "eq",
                value: "",
              })
            }
          >
            <PropertyIcon type={prop.content.type} />
            {prop.name}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
};

const ENTITY_KINDS = ["document", "folder", "task", "message"] as const;

type FilterChipWrapperProps = {
  label: string;
  onRemove: () => void;
  children: ReactNode;
};

const FilterChipWrapper = ({
  label,
  onRemove,
  children,
}: FilterChipWrapperProps) => (
  <div className="bg-muted/50 flex items-center gap-1 rounded-md border">
    <span className="ps-2 text-xs font-medium">{label}</span>
    {children}
    <Button onClick={onRemove} size="icon-xs" variant="ghost">
      <XIcon />
    </Button>
  </div>
);

type KindFilterChipProps = {
  filter: Extract<ViewFilterCondition, { field: "kind" }>;
  onChange: (filter: ViewFilterCondition) => void;
  onRemove: () => void;
};

const KindFilterChip = ({
  filter,
  onChange,
  onRemove,
}: KindFilterChipProps) => {
  const t = useTranslations();
  const label =
    filter.value.length === 0 ? t("common.all") : filter.value.join(", ");

  return (
    <FilterChipWrapper label={t("common.kind")} onRemove={onRemove}>
      <Select
        multiple
        onValueChange={(kinds) => onChange({ ...filter, value: kinds })}
        value={filter.value}
      >
        <FilterSelectTrigger>{label}</FilterSelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {ENTITY_KINDS.map((kind) => (
            <SelectItem key={kind} value={kind}>
              {kind}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </FilterChipWrapper>
  );
};

type PropertyFilterChipProps = {
  filter: Extract<ViewFilterCondition, { field: "property" }>;
  properties: WorkspaceProperty[];
  onChange: (filter: ViewFilterCondition) => void;
  onRemove: () => void;
};

const PropertyFilterChip = ({
  filter,
  properties,
  onChange,
  onRemove,
}: PropertyFilterChipProps) => {
  const t = useTranslations();
  const label = properties.find((p) => p.id === filter.propertyId)?.name;

  const options = [
    { value: "eq", label: t("filters.eq") },
    { value: "neq", label: t("filters.neq") },
    { value: "contains", label: t("filters.contains") },
    { value: "is_empty", label: t("filters.is_empty") },
  ] as const;

  if (!label) {
    return null;
  }

  return (
    <FilterChipWrapper label={label} onRemove={onRemove}>
      <Select
        onValueChange={(op) => {
          if (op) {
            onChange({ ...filter, op });
          }
        }}
        value={filter.op}
      >
        <FilterSelectTrigger>
          {options.find((o) => o.value === filter.op)?.label}
        </FilterSelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {options.map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {filter.op !== "is_empty" && (
        <Input
          className="h-6! w-24 border-0 bg-transparent px-1 text-xs shadow-none"
          onChange={(e) =>
            onChange({
              ...filter,
              value: e.currentTarget.value,
            })
          }
          size="sm"
          value={String(filter.value ?? "")}
        />
      )}
    </FilterChipWrapper>
  );
};

const FilterSelectTrigger = ({ children }: PropsWithChildren) => (
  <SelectTrigger
    className="w-auto! min-w-min! gap-0.5 border-0 bg-transparent px-1 text-xs! shadow-none [&_svg]:size-3"
    size="sm"
  >
    <SelectValue>{(): ReactNode => children}</SelectValue>
  </SelectTrigger>
);
