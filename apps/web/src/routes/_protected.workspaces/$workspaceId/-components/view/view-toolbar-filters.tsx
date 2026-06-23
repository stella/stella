import { useState } from "react";

import {
  CircleDotIcon,
  FilterIcon,
  FlagIcon,
  LayersIcon,
  MoreHorizontalIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { ConditionNode, GroupNode } from "@stll/conditions";
import { Button } from "@stll/ui/components/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@stll/ui/components/command";
import { Input } from "@stll/ui/components/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import { DatePickerPopover } from "@/components/date-picker-popover";
import type { TranslationKey } from "@/i18n/types";
import type { WorkspaceProperty } from "@/lib/types";
import { ConditionBuilder } from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-builder";
import type {
  ConditionOperator,
  FieldOption,
} from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-builder.logic";
import {
  buildLeaf,
  fieldForNode,
  isMultiValue,
  leafFromField,
  leafOperator,
  leafValueList,
  leafValueString,
  operatorLabelKey,
  operatorsFor,
  valueEditorFor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-builder.logic";
import type { FacetContext } from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-select-values";
import {
  MultiSelectValue,
  SingleSelectValue,
} from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-select-values";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";

type FilterChipsProps = {
  filters: ConditionNode[];
  properties: WorkspaceProperty[];
  facetContext?: FacetContext | undefined;
  onUpdate: (filters: ConditionNode[]) => void;
};

export const FilterChips = ({
  filters,
  properties,
  facetContext,
  onUpdate,
}: FilterChipsProps) => {
  const t = useTranslations();
  const fields = useFilterFields(properties);

  const replaceAt = (index: number, node: ConditionNode) => {
    onUpdate(filters.map((existing, i) => (i === index ? node : existing)));
  };
  const removeAt = (index: number) => {
    onUpdate(filters.filter((_, i) => i !== index));
  };
  const append = (node: ConditionNode) => {
    onUpdate([...filters, node]);
  };

  // The backend rejects a second top-level kind filter, so drop "Kind" from
  // the add picker once one already exists.
  const hasKindFilter = filters.some(
    (node) => node.type === "predicate" && node.operand.type === "kind",
  );
  const pickerFields = hasKindFilter
    ? fields.filter((field) => field.operand.type !== "kind")
    : fields;

  if (filters.length === 0) {
    return (
      <AddFilterPicker
        fields={pickerFields}
        onAddAdvanced={() => append(emptyAdvancedGroup())}
        onAddField={(field) => append(leafFromField(field))}
        trigger={
          <Button
            aria-label={t("workspaces.views.filter")}
            className="gap-1.5"
            size="xs"
            title={t("workspaces.views.filter")}
            variant="ghost"
          >
            <FilterIcon className="size-3.5" />
            <span className="hidden sm:inline">
              {t("workspaces.views.filter")}
            </span>
          </Button>
        }
      />
    );
  }

  return (
    <>
      {filters.map((node, index) => {
        if (node.type === "group") {
          return (
            <AdvancedFilterChip
              facetContext={facetContext}
              fields={fields}
              key={index}
              node={node}
              onChange={(next) => replaceAt(index, next)}
              onRemove={() => removeAt(index)}
            />
          );
        }
        return (
          <FilterChip
            facetContext={facetContext}
            fields={fields}
            key={index}
            node={node}
            onChange={(next) => replaceAt(index, next)}
            onRemove={() => removeAt(index)}
          />
        );
      })}
      <AddFilterPicker
        fields={pickerFields}
        onAddAdvanced={() => append(emptyAdvancedGroup())}
        onAddField={(field) => append(leafFromField(field))}
        trigger={
          <Button
            aria-label={t("workspaces.views.filter")}
            className="gap-1.5"
            size="xs"
            title={t("workspaces.views.filter")}
            variant="ghost"
          >
            <FilterIcon className="size-3.5" />
            <span className="hidden sm:inline">
              {t("workspaces.views.filter")}
            </span>
          </Button>
        }
      />
    </>
  );
};

// ── Simple chip ───────────────────────────────────────────

type FilterChipProps = {
  node: ConditionNode;
  fields: FieldOption[];
  facetContext?: FacetContext | undefined;
  onChange: (next: ConditionNode) => void;
  onRemove: () => void;
};

const FilterChip = ({
  node,
  fields,
  facetContext,
  onChange,
  onRemove,
}: FilterChipProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const field = fieldForNode(node, fields);
  const operator = leafOperator(node);

  if (!field || !operator) {
    return null;
  }

  const valueColor = chipValueColor(field, node, operator);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            className="gap-1.5 font-normal"
            size="xs"
            variant="secondary"
          />
        }
      >
        <FieldTypeIcon field={field} />
        <span className="text-foreground">{field.label}</span>
        {valueColor !== undefined && (
          <SelectColorIcon className="size-3.5" color={valueColor} />
        )}
        <span className="text-muted-foreground">
          {chipSummary({
            field,
            node,
            operator,
            operatorLabel: t(operatorLabelKey(field.valueType, operator)),
          })}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72 p-0">
        <FilterEditBody
          facetContext={facetContext}
          field={field}
          node={node}
          onChange={onChange}
          onRemove={() => {
            onRemove();
            setOpen(false);
          }}
          operator={operator}
        />
      </PopoverPopup>
    </Popover>
  );
};

type FilterEditBodyProps = {
  field: FieldOption;
  node: ConditionNode;
  operator: ConditionOperator;
  facetContext?: FacetContext | undefined;
  onChange: (next: ConditionNode) => void;
  onRemove: () => void;
};

const FilterEditBody = ({
  field,
  node,
  operator,
  facetContext,
  onChange,
  onRemove,
}: FilterEditBodyProps) => {
  const t = useTranslations();
  const operators = operatorsFor(field.valueType);
  const editorKind = valueEditorFor(field.valueType, operator);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 border-b px-2.5 py-2">
        <FieldTypeIcon field={field} />
        <span className="flex-1 truncate text-sm font-medium">
          {field.label}
        </span>
        <Menu>
          <MenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => onChange(leafFromField(field))}>
              {t("common.duplicate")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={onRemove} variant="destructive">
              {t("common.delete")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <div className="flex flex-col gap-2 p-2.5">
        <Select
          onValueChange={(next) => {
            if (next === null) {
              return;
            }
            onChange(
              buildLeaf({
                operand: field.operand,
                operator: next,
                value: isMultiValue(next)
                  ? leafValueList(node)
                  : leafValueString(node),
              }),
            );
          }}
          value={operator}
        >
          <SelectTrigger className="h-7 min-h-0 w-full text-xs" size="sm">
            <SelectValue>
              {() => t(operatorLabelKey(field.valueType, operator))}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {operators.map((op) => (
              <SelectItem key={op} value={op}>
                {t(operatorLabelKey(field.valueType, op))}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>

        <ValueEditor
          editorKind={editorKind}
          facetContext={facetContext}
          field={field}
          node={node}
          onChange={onChange}
          operator={operator}
        />
      </div>
    </div>
  );
};

type ValueEditorProps = {
  editorKind: ReturnType<typeof valueEditorFor>;
  field: FieldOption;
  node: ConditionNode;
  operator: ConditionOperator;
  facetContext?: FacetContext | undefined;
  onChange: (next: ConditionNode) => void;
};

const ValueEditor = ({
  editorKind,
  field,
  node,
  operator,
  facetContext,
  onChange,
}: ValueEditorProps) => {
  const t = useTranslations();

  if (editorKind === "none") {
    return null;
  }

  const emit = (value: string | string[]) => {
    onChange(buildLeaf({ operand: field.operand, operator, value }));
  };

  if (editorKind === "select") {
    if (isMultiValue(operator)) {
      return (
        <MultiSelectValue
          className="w-full"
          facetContext={facetContext}
          field={field}
          onChange={emit}
          value={leafValueList(node)}
        />
      );
    }
    return (
      <SingleSelectValue
        className="w-full"
        facetContext={facetContext}
        field={field}
        onChange={emit}
        value={leafValueString(node)}
      />
    );
  }

  if (editorKind === "int") {
    return (
      <Input
        autoFocus
        className="h-7! w-full text-xs"
        onChange={(e) => emit(e.currentTarget.value)}
        size="sm"
        type="number"
        value={leafValueString(node)}
      />
    );
  }

  if (editorKind === "date") {
    return (
      <div className="border-input bg-background rounded-md border px-1">
        <DatePickerPopover
          onChange={(next) => emit(next ?? "")}
          value={leafValueString(node) || null}
        />
      </div>
    );
  }

  return (
    <Input
      autoFocus
      className="h-7! w-full text-xs"
      onChange={(e) => emit(e.currentTarget.value)}
      placeholder={t("workspaces.properties.enterAValue")}
      size="sm"
      value={leafValueString(node)}
    />
  );
};

// ── Advanced (AND/OR group) chip ──────────────────────────

type AdvancedFilterChipProps = {
  node: GroupNode;
  fields: FieldOption[];
  facetContext?: FacetContext | undefined;
  onChange: (next: GroupNode) => void;
  onRemove: () => void;
};

const AdvancedFilterChip = ({
  node,
  fields,
  facetContext,
  onChange,
  onRemove,
}: AdvancedFilterChipProps) => {
  const t = useTranslations();

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            className="gap-1.5 font-normal"
            size="xs"
            variant="secondary"
          />
        }
      >
        <SlidersHorizontalIcon className="size-3.5" />
        <span className="text-foreground">
          {t("workspaces.views.advancedFilter")}
        </span>
        <span className="text-muted-foreground">
          {t("workspaces.views.advancedFilterCount", {
            count: node.children.length,
          })}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[34rem] max-w-[90vw] p-3">
        <ConditionBuilder
          allowGroups
          facetContext={facetContext}
          fields={fields}
          onChange={onChange}
          value={node}
        />
        <div className="mt-2 border-t pt-2">
          <Button
            className="text-muted-foreground"
            onClick={onRemove}
            size="xs"
            variant="ghost"
          >
            {t("workspaces.views.removeAdvancedFilter")}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
};

// ── Add picker ────────────────────────────────────────────

type AddFilterPickerProps = {
  fields: FieldOption[];
  trigger: React.ReactElement;
  onAddField: (field: FieldOption) => void;
  onAddAdvanced: () => void;
};

const AddFilterPicker = ({
  fields,
  trigger,
  onAddField,
  onAddAdvanced,
}: AddFilterPickerProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const normalized = query.trim().toLowerCase();
  const visible = normalized
    ? fields.filter((field) => field.label.toLowerCase().includes(normalized))
    : fields;

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger render={trigger} />
      <PopoverPopup align="start" className="w-64 p-0">
        <Command mode="none" onValueChange={setQuery} value={query}>
          <div className="border-b px-2.5 py-2">
            <CommandInput
              autoFocus
              placeholder={t("workspaces.views.filterByPlaceholder")}
              size="sm"
            />
          </div>
          <CommandList className="p-1">
            {visible.length === 0 && (
              <p className="text-muted-foreground px-2 py-1.5 text-sm">
                {t("common.noResults")}
              </p>
            )}
            {visible.map((field) => (
              <CommandItem
                key={fieldKey(field)}
                onClick={() => {
                  onAddField(field);
                  close();
                }}
                value={field.label}
              >
                <FieldTypeIcon field={field} />
                {field.label}
              </CommandItem>
            ))}
            <CommandSeparator className="my-1" />
            <CommandItem
              onClick={() => {
                onAddAdvanced();
                close();
              }}
              value="__advanced__"
            >
              <SlidersHorizontalIcon className="text-muted-foreground" />
              {t("workspaces.views.addAdvancedFilter")}
            </CommandItem>
          </CommandList>
        </Command>
      </PopoverPopup>
    </Popover>
  );
};

const FieldTypeIcon = ({ field }: { field: FieldOption }) => {
  if (field.valueType === "kind") {
    return <LayersIcon className="text-muted-foreground" />;
  }
  if (field.valueType === "status") {
    return <CircleDotIcon className="text-muted-foreground" />;
  }
  if (field.valueType === "priority") {
    return <FlagIcon className="text-muted-foreground" />;
  }
  return <PropertyIcon className="text-muted-foreground" type={field.type} />;
};

// ── Chip summary ──────────────────────────────────────────

type ChipSummaryArgs = {
  field: FieldOption;
  node: ConditionNode;
  operator: ConditionOperator;
  operatorLabel: string;
};

const optionLabel = (field: FieldOption, value: string): string =>
  field.options?.find((option) => option.value === value)?.label ?? value;

/**
 * The option colour for a single-value select chip, so the chip shows the
 * same swatch the column cell and group header do. Multi-value and
 * non-select operators have no single swatch to show.
 */
const chipValueColor = (
  field: FieldOption,
  node: ConditionNode,
  operator: ConditionOperator,
): string | undefined => {
  if (
    isMultiValue(operator) ||
    valueEditorFor(field.valueType, operator) !== "select"
  ) {
    return undefined;
  }
  const value = leafValueString(node);
  return field.options?.find((option) => option.value === value)?.color;
};

const chipSummary = ({
  field,
  node,
  operator,
  operatorLabel,
}: ChipSummaryArgs): string => {
  const editorKind = valueEditorFor(field.valueType, operator);

  if (editorKind === "none") {
    return operatorLabel;
  }

  if (isMultiValue(operator)) {
    const values = leafValueList(node).map((value) =>
      optionLabel(field, value),
    );
    if (values.length === 0) {
      return operatorLabel;
    }
    return `${operatorLabel} ${values.join(", ")}`;
  }

  const raw = leafValueString(node);
  if (!raw) {
    return operatorLabel;
  }
  const display = editorKind === "select" ? optionLabel(field, raw) : raw;
  return `${operatorLabel} ${display}`;
};

// ── Field catalogue ───────────────────────────────────────

const emptyAdvancedGroup = (): GroupNode => ({
  type: "group",
  combinator: "and",
  children: [],
});

const fieldKey = (field: FieldOption): string => {
  if (field.operand.type === "property") {
    return `property:${field.operand.propertyId}`;
  }
  if (field.operand.type === "builtin") {
    return `builtin:${field.operand.field}`;
  }
  return field.operand.type;
};

const ENTITY_KINDS = ["document", "task"] as const;

const KIND_LABEL_KEYS = {
  document: "search.kinds.document",
  task: "search.kinds.task",
} as const satisfies Record<(typeof ENTITY_KINDS)[number], TranslationKey>;

const STATUS_VALUES = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

const PRIORITY_VALUES = ["none", "urgent", "high", "medium", "low"] as const;

const STATUS_VALUE_LABEL_KEYS = {
  open: "tasks.statusValues.open",
  in_progress: "tasks.statusValues.in_progress",
  in_review: "tasks.statusValues.in_review",
  done: "tasks.statusValues.done",
  cancelled: "tasks.statusValues.cancelled",
} as const satisfies Record<(typeof STATUS_VALUES)[number], TranslationKey>;

const PRIORITY_VALUE_LABEL_KEYS = {
  none: "tasks.priorityValues.none",
  urgent: "tasks.priorityValues.urgent",
  high: "tasks.priorityValues.high",
  medium: "tasks.priorityValues.medium",
  low: "tasks.priorityValues.low",
} as const satisfies Record<(typeof PRIORITY_VALUES)[number], TranslationKey>;

/** Builds the operands a view filter may target: kind, builtins, properties. */
const useFilterFields = (properties: WorkspaceProperty[]): FieldOption[] => {
  const t = useTranslations();

  const fields: FieldOption[] = [
    {
      operand: { type: "kind" },
      label: t("common.kind"),
      valueType: "kind",
      type: "text",
      options: ENTITY_KINDS.map((kind) => ({
        value: kind,
        label: t(KIND_LABEL_KEYS[kind]),
      })),
    },
    {
      operand: { type: "builtin", field: "status" },
      label: t("common.status"),
      valueType: "status",
      type: "single-select",
      options: STATUS_VALUES.map((value) => ({
        value,
        label: t(STATUS_VALUE_LABEL_KEYS[value]),
      })),
    },
    {
      operand: { type: "builtin", field: "priority" },
      label: t("tasks.priority"),
      valueType: "priority",
      type: "single-select",
      options: PRIORITY_VALUES.map((value) => ({
        value,
        label: t(PRIORITY_VALUE_LABEL_KEYS[value]),
      })),
    },
  ];

  for (const property of properties) {
    if (property.content.type === "file") {
      continue;
    }
    if (
      property.content.type === "single-select" ||
      property.content.type === "multi-select"
    ) {
      fields.push({
        operand: { type: "property", propertyId: property.id },
        label: property.name,
        valueType: property.content.type,
        type: property.content.type,
        options: property.content.options.map((option) => ({
          value: option.value,
          label: option.value,
          color: option.color,
        })),
      });
      continue;
    }
    fields.push({
      operand: { type: "property", propertyId: property.id },
      label: property.name,
      valueType: property.content.type,
      type: property.content.type,
    });
  }

  return fields;
};
