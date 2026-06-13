import { FilterIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { ConditionNode, GroupNode } from "@stll/conditions";
import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";

import type { TranslationKey } from "@/i18n/types";
import type { WorkspaceProperty } from "@/lib/types";
import { ConditionBuilder } from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-builder";
import type { FieldOption } from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-builder.logic";

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
  const t = useTranslations();
  const fields = useFilterFields(properties);

  // View filters persist as a flat `ConditionNode[]` evaluated with
  // implicit AND, so the builder runs as a flat AND group and we write
  // its children straight back to that array.
  const group: GroupNode = {
    type: "group",
    combinator: "and",
    children: filters,
  };
  const count = filters.length;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            className="gap-1.5"
            size="xs"
            variant={count > 0 ? "secondary" : "ghost"}
          />
        }
      >
        <FilterIcon className="size-3.5" />
        {count > 0
          ? t("workspaces.views.filtersWithCount", { count })
          : t("workspaces.views.filter")}
      </PopoverTrigger>
      <PopoverPopup className="w-auto max-w-[min(36rem,90vw)] p-3">
        <ConditionBuilder
          fields={fields}
          onChange={(next) => onUpdate(next.children)}
          value={group}
        />
      </PopoverPopup>
    </Popover>
  );
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
      options: ENTITY_KINDS.map((kind) => ({
        value: kind,
        label: t(KIND_LABEL_KEYS[kind]),
      })),
    },
    {
      operand: { type: "builtin", field: "status" },
      label: t("common.status"),
      valueType: "status",
      options: STATUS_VALUES.map((value) => ({
        value,
        label: t(STATUS_VALUE_LABEL_KEYS[value]),
      })),
    },
    {
      operand: { type: "builtin", field: "priority" },
      label: t("tasks.priority"),
      valueType: "priority",
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
    });
  }

  return fields;
};
