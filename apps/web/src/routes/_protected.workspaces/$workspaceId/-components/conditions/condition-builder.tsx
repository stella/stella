import { PlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { Combinator, ConditionNode, GroupNode } from "@stll/conditions";
import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { cn } from "@stll/ui/lib/utils";

import { DatePickerPopover } from "@/components/date-picker-popover";
import type {
  ConditionOperator,
  FieldOption,
} from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-builder.logic";
import {
  appendChild,
  asGroup,
  buildLeaf,
  isConditionOperator,
  isMultiValue,
  leafFromField,
  leafOperand,
  leafOperator,
  leafValueList,
  leafValueString,
  operandsEqual,
  operatorLabelKey,
  operatorsFor,
  removeChild,
  replaceChild,
  valueEditorFor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/condition-builder.logic";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";

type ConditionBuilderProps = {
  value: ConditionNode | null;
  onChange: (next: GroupNode) => void;
  fields: FieldOption[];
  allowGroups?: boolean;
};

export const ConditionBuilder = ({
  value,
  onChange,
  fields,
  allowGroups = false,
}: ConditionBuilderProps) => {
  const t = useTranslations();
  const group = asGroup(value);

  if (fields.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("workspaces.properties.noConditionFields")}
      </p>
    );
  }

  const firstField = fields.at(0);

  return (
    <div className="flex flex-col gap-2">
      {allowGroups && group.children.length > 1 && (
        <CombinatorControl
          combinator={group.combinator}
          onChange={(combinator) => onChange({ ...group, combinator })}
        />
      )}

      <div className="flex flex-col gap-2">
        {group.children.map((child, index) => {
          if (child.type === "group" && allowGroups) {
            return (
              <NestedGroupRow
                fields={fields}
                key={index}
                onChange={(next) => onChange(replaceChild(group, index, next))}
                onRemove={() => onChange(removeChild(group, index))}
                value={child}
              />
            );
          }
          return (
            <LeafRow
              fields={fields}
              key={index}
              node={child}
              onChange={(next) => onChange(replaceChild(group, index, next))}
              onRemove={() => onChange(removeChild(group, index))}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Button
          className="justify-start"
          disabled={!firstField}
          onClick={() => {
            if (firstField) {
              onChange(appendChild(group, leafFromField(firstField)));
            }
          }}
          size="xs"
          type="button"
          variant="ghost"
        >
          <PlusIcon />
          {t("workspaces.properties.addCondition")}
        </Button>
        {allowGroups && (
          <Button
            className="justify-start"
            onClick={() =>
              onChange(
                appendChild(group, {
                  type: "group",
                  combinator: "and",
                  children: firstField ? [leafFromField(firstField)] : [],
                }),
              )
            }
            size="xs"
            type="button"
            variant="ghost"
          >
            <PlusIcon />
            {t("common.add")}
          </Button>
        )}
      </div>
    </div>
  );
};

type CombinatorControlProps = {
  combinator: Combinator;
  onChange: (combinator: Combinator) => void;
};

const COMBINATORS = ["and", "or"] as const;

const COMBINATOR_LABEL_KEYS = {
  and: "common.and",
  or: "common.or",
} as const;

const CombinatorControl = ({
  combinator,
  onChange,
}: CombinatorControlProps) => {
  const t = useTranslations();

  return (
    <div className="border-border/70 bg-muted/30 inline-flex w-fit items-center gap-0.5 rounded-md border p-0.5">
      {COMBINATORS.map((option) => {
        const isActive = option === combinator;
        return (
          <Button
            aria-pressed={isActive}
            className={cn(
              "text-muted-foreground h-6 min-h-0 rounded-[4px]",
              isActive &&
                "bg-muted text-foreground ring-border/80 shadow-xs ring-1",
            )}
            key={option}
            onClick={() => onChange(option)}
            size="xs"
            type="button"
            variant="ghost"
          >
            {t(COMBINATOR_LABEL_KEYS[option])}
          </Button>
        );
      })}
    </div>
  );
};

type NestedGroupRowProps = {
  value: GroupNode;
  fields: FieldOption[];
  onChange: (next: GroupNode) => void;
  onRemove: () => void;
};

const NestedGroupRow = ({
  value,
  fields,
  onChange,
  onRemove,
}: NestedGroupRowProps) => (
  <div className="border-border/70 bg-muted/20 flex items-start gap-2 rounded-md border p-2">
    <div className="flex-1">
      <ConditionBuilder
        allowGroups
        fields={fields}
        onChange={onChange}
        value={value}
      />
    </div>
    <Button onClick={onRemove} size="icon-xs" type="button" variant="ghost">
      <XIcon />
    </Button>
  </div>
);

type LeafRowProps = {
  node: ConditionNode;
  fields: FieldOption[];
  onChange: (next: ConditionNode) => void;
  onRemove: () => void;
};

const LeafRow = ({ node, fields, onChange, onRemove }: LeafRowProps) => {
  const t = useTranslations();
  const operand = leafOperand(node);
  const fieldIndex = operand
    ? fields.findIndex((f) => operandsEqual(f.operand, operand))
    : -1;
  const field = fields[fieldIndex];

  if (!field) {
    return null;
  }

  const operator = leafOperator(node) ?? operatorsFor(field.valueType).at(0);

  if (!operator) {
    return null;
  }

  const operators = operatorsFor(field.valueType);
  const editorKind = valueEditorFor(field.valueType, operator);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        onValueChange={(next) => {
          if (next === null) {
            return;
          }
          const nextField = fields[Number(next)];
          if (nextField) {
            onChange(leafFromField(nextField));
          }
        }}
        value={String(fieldIndex)}
      >
        <SelectTrigger
          className="h-7 min-h-0 w-auto min-w-32 text-xs"
          size="sm"
        >
          <SelectValue placeholder={t("workspaces.properties.selectField")}>
            {field.label}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {fields.map((option, index) => (
            <SelectItem key={index} value={String(index)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      <Select
        onValueChange={(next) => {
          if (next === null || !isConditionOperator(next)) {
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
        <SelectTrigger
          className="h-7 min-h-0 w-auto min-w-24 text-xs"
          size="sm"
        >
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

      <LeafValueEditor
        editorKind={editorKind}
        field={field}
        node={node}
        onChange={onChange}
        operator={operator}
      />

      <Button onClick={onRemove} size="icon-xs" type="button" variant="ghost">
        <XIcon />
      </Button>
    </div>
  );
};

type LeafValueEditorProps = {
  editorKind: ReturnType<typeof valueEditorFor>;
  field: FieldOption;
  node: ConditionNode;
  operator: ConditionOperator;
  onChange: (next: ConditionNode) => void;
};

const LeafValueEditor = ({
  editorKind,
  field,
  node,
  operator,
  onChange,
}: LeafValueEditorProps) => {
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
          field={field}
          onChange={emit}
          value={leafValueList(node)}
        />
      );
    }
    return (
      <SingleSelectValue
        field={field}
        onChange={emit}
        value={leafValueString(node)}
      />
    );
  }

  if (editorKind === "int") {
    return (
      <Input
        className="h-7! w-24 text-xs"
        onChange={(e) => emit(e.currentTarget.value)}
        size="sm"
        type="number"
        value={leafValueString(node)}
      />
    );
  }

  if (editorKind === "date") {
    return (
      <div className="border-input bg-background min-w-28 rounded-md border px-1">
        <DatePickerPopover
          onChange={(next) => emit(next ?? "")}
          value={leafValueString(node) || null}
        />
      </div>
    );
  }

  return (
    <Input
      className="h-7! w-32 text-xs"
      onChange={(e) => emit(e.currentTarget.value)}
      placeholder={t("workspaces.properties.enterAValue")}
      size="sm"
      value={leafValueString(node)}
    />
  );
};

type SelectValueEditorProps = {
  field: FieldOption;
  value: string;
  onChange: (value: string) => void;
};

const SingleSelectValue = ({
  field,
  value,
  onChange,
}: SelectValueEditorProps) => {
  const t = useTranslations();
  const options = field.options ?? [];
  const selected = options.find((option) => option.value === value);

  return (
    <Select
      onValueChange={(next) => {
        if (next !== null) {
          onChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger className="h-7 min-h-0 w-auto min-w-28 text-xs" size="sm">
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
            <span className="flex items-center gap-1.5">
              {option.color !== undefined && (
                <SelectColorIcon color={option.color} />
              )}
              {option.label}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

type MultiSelectValueProps = {
  field: FieldOption;
  value: string[];
  onChange: (value: string[]) => void;
};

const MultiSelectValue = ({
  field,
  value,
  onChange,
}: MultiSelectValueProps) => {
  const t = useTranslations();
  const options = field.options ?? [];
  const label =
    value.length === 0
      ? t("workspaces.fields.selectValues")
      : value
          .map((v) => options.find((option) => option.value === v)?.label ?? v)
          .join(", ");

  return (
    <Select multiple onValueChange={(next) => onChange(next)} value={value}>
      <SelectTrigger className="h-7 min-h-0 w-auto min-w-28 text-xs" size="sm">
        <SelectValue>{() => label}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex items-center gap-1.5">
              {option.color !== undefined && (
                <SelectColorIcon color={option.color} />
              )}
              {option.label}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};
