import type { PropsWithChildren, ReactNode } from "react";

import type { LucideIcon } from "lucide-react";
import {
  CircleDotIcon,
  FileTextIcon,
  FilterIcon,
  FolderIcon,
  SignalIcon,
  SquareCheckIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { BuiltinField, ConditionNode } from "@stll/conditions";
import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import type { TranslationKey } from "@/i18n/types";
import type { WorkspaceProperty } from "@/lib/types";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";

const KIND_ICONS: Record<string, LucideIcon> = {
  document: FileTextIcon,
  folder: FolderIcon,
  task: SquareCheckIcon,
};

type FilterChipsProps = {
  filters: ConditionNode[];
  properties: WorkspaceProperty[];
  onUpdate: (filters: ConditionNode[]) => void;
};

export const FilterChips = ({
  filters,
  properties,
  onUpdate,
}: FilterChipsProps) => {
  const handleChange = (index: number, updated: ConditionNode) => {
    onUpdate(filters.map((node, i) => (i === index ? updated : node)));
  };

  const handleRemove = (index: number) => {
    onUpdate(filters.filter((_, i) => i !== index));
  };

  const renderChip = (filter: ConditionNode, index: number) => {
    const shared = {
      onChange: (updated: ConditionNode) => handleChange(index, updated),
      onRemove: () => handleRemove(index),
    };

    const kind = kindOf(filter);
    switch (kind) {
      case "kind":
        return <KindFilterChip filter={filter} key={index} {...shared} />;
      case "builtin":
        return <BuiltinFilterChip filter={filter} key={index} {...shared} />;
      case "property":
        return (
          <PropertyFilterChip
            filter={filter}
            key={index}
            properties={properties}
            {...shared}
          />
        );
      default:
        return null;
    }
  };

  return (
    <>
      {filters.map(renderChip)}
      <AddFilterButton
        filters={filters}
        onAdd={(filter) => onUpdate([...filters, filter])}
        properties={properties}
      />
    </>
  );
};

// -- Node shape helpers --

type FilterKind = "kind" | "builtin" | "property" | null;

/** Classifies a node by the operand its leaf references. */
const kindOf = (node: ConditionNode): FilterKind => {
  if (node.type === "predicate") {
    return operandKind(node.operand.type);
  }
  if (node.type === "compare") {
    return operandKind(node.left.type);
  }
  return null;
};

const operandKind = (type: string): FilterKind => {
  if (type === "kind" || type === "builtin" || type === "property") {
    return type;
  }
  return null;
};

const kindNode = (values: string[]): ConditionNode => ({
  type: "predicate",
  operand: { type: "kind" },
  op: "in",
  value: values,
});

const kindValues = (node: ConditionNode): string[] => {
  if (node.type === "predicate" && Array.isArray(node.value)) {
    return node.value;
  }
  return [];
};

type LeafOp = "eq" | "neq" | "contains" | "is_empty";

/** The user-visible operator for a builtin/property leaf node. */
const leafOp = (node: ConditionNode): LeafOp => {
  if (node.type === "compare") {
    return node.op === "neq" ? "neq" : "eq";
  }
  if (node.type === "predicate" && node.op === "contains") {
    return "contains";
  }
  return "is_empty";
};

const leafValue = (node: ConditionNode): string => {
  if (node.type === "compare" && node.right.type === "literal") {
    return String(node.right.value);
  }
  if (node.type === "predicate" && typeof node.value === "string") {
    return node.value;
  }
  return "";
};

type BuiltinOp = "eq" | "neq" | "is_empty";

const builtinNode = (
  field: BuiltinField,
  op: BuiltinOp,
  value: string,
): ConditionNode => {
  if (op === "is_empty") {
    return { type: "predicate", operand: { type: "builtin", field }, op };
  }
  return {
    type: "compare",
    left: { type: "builtin", field },
    op,
    right: { type: "literal", value },
  };
};

const builtinField = (node: ConditionNode): BuiltinField => {
  if (node.type === "compare" && node.left.type === "builtin") {
    return node.left.field;
  }
  if (node.type === "predicate" && node.operand.type === "builtin") {
    return node.operand.field;
  }
  return "status";
};

const propertyNode = (
  propertyId: string,
  op: LeafOp,
  value: string,
): ConditionNode => {
  if (op === "contains") {
    return {
      type: "predicate",
      operand: { type: "property", propertyId },
      op: "contains",
      value,
    };
  }
  if (op === "is_empty") {
    return {
      type: "predicate",
      operand: { type: "property", propertyId },
      op: "is_empty",
    };
  }
  return {
    type: "compare",
    left: { type: "property", propertyId },
    op,
    right: { type: "literal", value },
  };
};

const propertyId = (node: ConditionNode): string => {
  if (node.type === "compare" && node.left.type === "property") {
    return node.left.propertyId;
  }
  if (node.type === "predicate" && node.operand.type === "property") {
    return node.operand.propertyId;
  }
  return "";
};

// -- Add filter --

type AddFilterButtonProps = {
  properties: WorkspaceProperty[];
  filters: ConditionNode[];
  onAdd: (filter: ConditionNode) => void;
};

const hasKindFilter = (filters: ConditionNode[]) =>
  filters.some((node) => kindOf(node) === "kind");

const hasBuiltinFilter = (filters: ConditionNode[], field: BuiltinField) =>
  filters.some(
    (node) => kindOf(node) === "builtin" && builtinField(node) === field,
  );

const AddFilterButton = ({
  properties,
  filters,
  onAdd,
}: AddFilterButtonProps) => {
  const t = useTranslations();

  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
        <FilterIcon />
      </MenuTrigger>
      <MenuPopup>
        <MenuItem
          disabled={hasKindFilter(filters)}
          onClick={() => onAdd(kindNode([]))}
        >
          <FilterIcon className="size-3.5" />
          {t("common.kind")}
        </MenuItem>
        <MenuItem
          disabled={hasBuiltinFilter(filters, "status")}
          onClick={() => onAdd(builtinNode("status", "eq", ""))}
        >
          <CircleDotIcon className="size-3.5" />
          {t("common.status")}
        </MenuItem>
        <MenuItem
          disabled={hasBuiltinFilter(filters, "priority")}
          onClick={() => onAdd(builtinNode("priority", "eq", ""))}
        >
          <SignalIcon className="size-3.5" />
          {t("tasks.priority")}
        </MenuItem>
        {properties
          .filter((p) => p.content.type !== "file")
          .map((prop) => (
            <MenuItem
              key={prop.id}
              onClick={() => onAdd(propertyNode(prop.id, "eq", ""))}
            >
              <PropertyIcon type={prop.content.type} />
              {prop.name}
            </MenuItem>
          ))}
      </MenuPopup>
    </Menu>
  );
};

const ENTITY_KINDS = ["document", "task"] as const;

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

type FilterChipProps = {
  filter: ConditionNode;
  onChange: (filter: ConditionNode) => void;
  onRemove: () => void;
};

const useKindLabels = (): Record<string, string> => {
  const t = useTranslations();
  return {
    document: t("search.kinds.document"),
    folder: t("search.kinds.folder"),
    task: t("search.kinds.task"),
    message: t("search.kinds.message"),
  };
};

const KindFilterChip = ({ filter, onChange, onRemove }: FilterChipProps) => {
  const t = useTranslations();
  const kindLabels = useKindLabels();
  const values = kindValues(filter);
  const label =
    values.length === 0
      ? t("common.all")
      : values.map((k) => kindLabels[k] ?? k).join(", ");

  return (
    <FilterChipWrapper label={t("common.kind")} onRemove={onRemove}>
      <Select
        multiple
        onValueChange={(kinds) => onChange(kindNode(kinds))}
        value={values}
      >
        <FilterSelectTrigger>{label}</FilterSelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {ENTITY_KINDS.map((kind) => {
            const Icon = KIND_ICONS[kind];
            return (
              <SelectItem key={kind} value={kind}>
                {Icon && <Icon className="size-3.5" />}
                {kindLabels[kind] ?? kind}
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
    </FilterChipWrapper>
  );
};

// -- Builtin field filter (status, priority) --

const STATUS_VALUES = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

const PRIORITY_VALUES = ["none", "urgent", "high", "medium", "low"] as const;

type StatusValue = (typeof STATUS_VALUES)[number];
type PriorityValue = (typeof PRIORITY_VALUES)[number];

const STATUS_VALUE_LABEL_KEYS = {
  open: "tasks.statusValues.open",
  in_progress: "tasks.statusValues.in_progress",
  in_review: "tasks.statusValues.in_review",
  done: "tasks.statusValues.done",
  cancelled: "tasks.statusValues.cancelled",
} satisfies Record<StatusValue, TranslationKey>;

const PRIORITY_VALUE_LABEL_KEYS = {
  none: "tasks.priorityValues.none",
  urgent: "tasks.priorityValues.urgent",
  high: "tasks.priorityValues.high",
  medium: "tasks.priorityValues.medium",
  low: "tasks.priorityValues.low",
} satisfies Record<PriorityValue, TranslationKey>;

const STATUS_VALUE_SET: ReadonlySet<string> = new Set(STATUS_VALUES);
const PRIORITY_VALUE_SET: ReadonlySet<string> = new Set(PRIORITY_VALUES);

const isStatusValue = (value: string): value is StatusValue =>
  STATUS_VALUE_SET.has(value);

const isPriorityValue = (value: string): value is PriorityValue =>
  PRIORITY_VALUE_SET.has(value);

const isLeafOp = (value: string): value is LeafOp =>
  value === "eq" ||
  value === "neq" ||
  value === "contains" ||
  value === "is_empty";

const isBuiltinOp = (value: string): value is BuiltinOp =>
  value === "eq" || value === "neq" || value === "is_empty";

const BuiltinFilterChip = ({ filter, onChange, onRemove }: FilterChipProps) => {
  const t = useTranslations();
  const field = builtinField(filter);
  const rawOp = leafOp(filter);
  const op: BuiltinOp = isBuiltinOp(rawOp) ? rawOp : "eq";
  const value = leafValue(filter);
  const isStatus = field === "status";
  const label = isStatus ? t("common.status") : t("tasks.priority");
  const values = isStatus ? STATUS_VALUES : PRIORITY_VALUES;

  const resolveLabel = (raw: string) => {
    if (isStatus) {
      return isStatusValue(raw) ? t(STATUS_VALUE_LABEL_KEYS[raw]) : raw;
    }
    return isPriorityValue(raw) ? t(PRIORITY_VALUE_LABEL_KEYS[raw]) : raw;
  };

  const opOptions = [
    { value: "eq", label: t("filters.eq") },
    { value: "neq", label: t("filters.neq") },
    { value: "is_empty", label: t("filters.is_empty") },
  ] as const;

  return (
    <FilterChipWrapper label={label} onRemove={onRemove}>
      <Select
        onValueChange={(nextOp) => {
          if (nextOp && isBuiltinOp(nextOp)) {
            onChange(builtinNode(field, nextOp, value));
          }
        }}
        value={op}
      >
        <FilterSelectTrigger>
          {opOptions.find((o) => o.value === op)?.label}
        </FilterSelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {opOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {op !== "is_empty" && (
        <Select
          onValueChange={(val) => {
            if (val !== null) {
              onChange(builtinNode(field, op, val));
            }
          }}
          value={value}
        >
          <FilterSelectTrigger>
            {value !== "" ? resolveLabel(value) : "…"}
          </FilterSelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {values.map((val) => (
              <SelectItem key={val} value={val}>
                {resolveLabel(val)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
    </FilterChipWrapper>
  );
};

type PropertyFilterChipProps = FilterChipProps & {
  properties: WorkspaceProperty[];
};

const PropertyFilterChip = ({
  filter,
  properties,
  onChange,
  onRemove,
}: PropertyFilterChipProps) => {
  const t = useTranslations();
  const id = propertyId(filter);
  const property = properties.find((p) => p.id === id);

  if (!property) {
    return null;
  }

  const op = leafOp(filter);
  const value = leafValue(filter);
  const isSingleSelect =
    property.content.type === "single-select" ||
    property.content.type === "multi-select";

  const selectOptions =
    property.content.type === "single-select" ||
    property.content.type === "multi-select"
      ? property.content.options
      : [];

  // For single-select: simpler ops (is / is not / is empty)
  const opOptions = isSingleSelect
    ? ([
        { value: "eq", label: t("filters.eq") },
        { value: "neq", label: t("filters.neq") },
        { value: "is_empty", label: t("filters.is_empty") },
      ] as const)
    : ([
        { value: "eq", label: t("filters.eq") },
        { value: "neq", label: t("filters.neq") },
        { value: "contains", label: t("filters.contains") },
        { value: "is_empty", label: t("filters.is_empty") },
      ] as const);

  return (
    <FilterChipWrapper label={property.name} onRemove={onRemove}>
      <Select
        onValueChange={(nextOp) => {
          if (nextOp && isLeafOp(nextOp)) {
            onChange(propertyNode(id, nextOp, value));
          }
        }}
        value={op}
      >
        <FilterSelectTrigger>
          {opOptions.find((o) => o.value === op)?.label}
        </FilterSelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {opOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {op !== "is_empty" &&
        (isSingleSelect ? (
          <Select
            onValueChange={(val) => {
              if (val !== null) {
                onChange(propertyNode(id, op, val));
              }
            }}
            value={value}
          >
            <FilterSelectTrigger>
              {value !== "" ? value : "…"}
            </FilterSelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {selectOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.value}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <Input
            className="h-6! w-24 border-0 bg-transparent px-1 text-xs shadow-none"
            onChange={(e) =>
              onChange(propertyNode(id, op, e.currentTarget.value))
            }
            size="sm"
            value={value}
          />
        ))}
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
