import type { ReactNode } from "react";

import { PlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { ConditionNode, GroupNode } from "@stll/conditions";
import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import {
  appendChild,
  asGroup,
  buildLeaf,
  type ConditionOperator,
  type FieldOption,
  type FieldValueType,
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
  type ValueEditorKind,
  valueEditorFor,
} from "@/components/conditions/condition-builder-logic";
import { FormulaCell } from "@/components/conditions/formula-editor";
import { DatePickerPopover } from "@/components/date-picker-popover";
import type { TranslationKey } from "@/i18n/types";

/** The parameter-less keys a host may pass for the "+ Add condition"
 *  affordance. Narrowed from the broad `TranslationKey` union (which also holds
 *  ICU-placeholder keys) so `t(key)` stays callable with a single argument. */
type AddConditionLabelKey = Extract<
  TranslationKey,
  "templates.conditionAddRule" | "workspaces.properties.addCondition"
>;

/** Parameter-less keys an `operatorLabelKey` override may return, narrowed from
 *  the broad `TranslationKey` union so the resolved label stays callable via
 *  `t(key)`. Covers the filter side's `filters.*` operator labels and the
 *  template side's friendly `templates.conditionOp*` labels. */
type OperatorLabelKey = Extract<
  TranslationKey,
  | "filters.eq"
  | "filters.neq"
  | "filters.contains"
  | "filters.not_contains"
  | "filters.starts_with"
  | "filters.ends_with"
  | "filters.contains_all"
  | "filters.in"
  | "filters.gt"
  | "filters.lt"
  | "filters.gte"
  | "filters.lte"
  | "filters.is_empty"
  | "filters.is_not_empty"
  | "filters.numEq"
  | "filters.numNeq"
  | "filters.numGt"
  | "filters.numLt"
  | "filters.numGte"
  | "filters.numLte"
  | "filters.dateAfter"
  | "filters.dateBefore"
  | "filters.dateOnOrAfter"
  | "filters.dateOnOrBefore"
  | "templates.conditionOpAfter"
  | "templates.conditionOpAtLeast"
  | "templates.conditionOpAtMost"
  | "templates.conditionOpBefore"
  | "templates.conditionOpContains"
  | "templates.conditionOpEquals"
  | "templates.conditionOpGreaterThan"
  | "templates.conditionOpIs"
  | "templates.conditionOpIsNot"
  | "templates.conditionOpLessThan"
  | "templates.conditionOpNotEquals"
  | "templates.conditionOpOn"
  | "templates.conditionOpOnOrAfter"
  | "templates.conditionOpOnOrBefore"
>;

/** Capability flags and host injections that let one recursive builder serve
 *  both the View filter surface and the template rule surface. The host owns
 *  the field list and (optionally) the value editors; the builder owns the
 *  tree shape, the gutter, nesting, and the formula escape hatch. */
export type ConditionCapabilities = {
  /** Operands the picker may target (property / builtin / kind / path). */
  fields: FieldOption[];
  /** Allow nested groups (the "+ Add group" affordance + bordered subgroups). */
  allowNesting?: boolean;
  /** Offer a "ƒ Calculated value…" item that switches a leaf's left operand to
   *  a formula edited via `FormulaCell`. */
  allowFormula?: boolean;
  /** Numeric operands a formula leaf may reference; required for `allowFormula`. */
  formulaNumberFields?: readonly { path: string; label: string }[];
  /** Host-injected value editor (e.g. faceted selects). Return null to fall back
   *  to the builder's built-in editor for that kind. */
  renderValueEditor?: (ctx: ValueEditorRenderCtx) => React.ReactNode | null;
  /** Label for the "+ Add condition" affordance. Narrowed to parameter-less
   *  keys so it stays callable via `t(key)`. */
  addConditionLabel?: AddConditionLabelKey;
  /** Restrict the operator set per value type (e.g. the template surface only
   *  exposes operators its serializer can render). Defaults to the logic's
   *  `operatorsFor`. */
  operatorsFor?: (valueType: FieldValueType) => readonly ConditionOperator[];
  /** Relabel operators per value type (e.g. friendly template wording).
   *  Defaults to the logic's `operatorLabelKey`. */
  operatorLabelKey?: (
    valueType: FieldValueType,
    op: ConditionOperator,
  ) => OperatorLabelKey;
  /** Override how a value type renders its value editor. Defaults to the logic's
   *  `valueEditorFor`. */
  valueEditorFor?: (
    valueType: FieldValueType,
    op: ConditionOperator,
  ) => ValueEditorKind;
};

export type ValueEditorRenderCtx = {
  editorKind: ValueEditorKind;
  field: FieldOption;
  node: ConditionNode;
  operator: ConditionOperator;
  emit: (value: string | string[]) => void;
};

type ConditionBuilderProps = {
  value: ConditionNode | null;
  onChange: (next: GroupNode) => void;
  capabilities: ConditionCapabilities;
};

/** The formula leaf's left operand carries no field type, so its operators come
 *  from the numeric set and its value editor is the int input. */
const FORMULA_VALUE_TYPE = "int" as const;

/** Sentinel select value that switches a leaf to a formula operand. Leads with a
 *  space so it never collides with a real field index. */
const FORMULA_OPTION = " formula";

export const ConditionBuilder = ({
  value,
  onChange,
  capabilities,
}: ConditionBuilderProps) => {
  const t = useTranslations();
  const group = asGroup(value);
  const { fields, allowNesting = false } = capabilities;
  const addConditionLabel =
    capabilities.addConditionLabel ?? "templates.conditionAddRule";

  const firstField = fields.at(0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2">
        {group.children.map((child, index) => {
          if (child.type === "group" && allowNesting) {
            return (
              <NestedGroupRow
                capabilities={capabilities}
                combinator={group.combinator}
                index={index}
                key={index}
                onChange={(next) => onChange(replaceChild(group, index, next))}
                onRemove={() => onChange(removeChild(group, index))}
                onSetCombinator={(combinator) =>
                  onChange({ ...group, combinator })
                }
                value={child}
              />
            );
          }
          return (
            <LeafRow
              capabilities={capabilities}
              combinator={group.combinator}
              index={index}
              key={index}
              node={child}
              onChange={(next) => onChange(replaceChild(group, index, next))}
              onRemove={() => onChange(removeChild(group, index))}
              onSetCombinator={(combinator) =>
                onChange({ ...group, combinator })
              }
            />
          );
        })}
      </div>

      <div className="ms-[5.375rem] flex flex-wrap gap-1">
        <Button
          className="w-fit justify-start"
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
          {t(addConditionLabel)}
        </Button>
        {allowNesting && (
          <Button
            className="w-fit justify-start"
            disabled={!firstField}
            onClick={() => {
              if (firstField) {
                onChange(
                  appendChild(group, {
                    type: "group",
                    combinator: "and",
                    children: [leafFromField(firstField)],
                  }),
                );
              }
            }}
            size="xs"
            type="button"
            variant="ghost"
          >
            <PlusIcon />
            {t("templates.conditionAddGroup")}
          </Button>
        )}
      </div>
    </div>
  );
};

/** Left gutter: row 0 reads "When", row 1 carries the editable And/Or that sets
 *  the group's combinator, later rows echo it read-only. A single-child group
 *  shows no combinator word at all. */
const ConditionGutter = ({
  index,
  combinator,
  onCombinator,
}: {
  index: number;
  combinator: GroupNode["combinator"];
  onCombinator: (next: GroupNode["combinator"]) => void;
}) => {
  const t = useTranslations();
  const gutterClass = "w-20 shrink-0 text-muted-foreground text-xs";

  if (index === 0) {
    return (
      <span className={`${gutterClass} ps-1`}>
        {t("templates.conditionWhen")}
      </span>
    );
  }
  if (index === 1) {
    return (
      <Select
        onValueChange={(next) => onCombinator(next === "or" ? "or" : "and")}
        value={combinator}
      >
        <SelectTrigger
          aria-label={t("templates.conditionMatch")}
          className="h-7 min-h-0 w-20 min-w-0 shrink-0 text-xs"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="and">{t("templates.conditionAnd")}</SelectItem>
          <SelectItem value="or">{t("templates.conditionOr")}</SelectItem>
        </SelectPopup>
      </Select>
    );
  }
  return (
    <span className={`${gutterClass} ps-1`}>
      {combinator === "or"
        ? t("templates.conditionOr")
        : t("templates.conditionAnd")}
    </span>
  );
};

type NestedGroupRowProps = {
  value: GroupNode;
  capabilities: ConditionCapabilities;
  index: number;
  combinator: GroupNode["combinator"];
  onChange: (next: GroupNode) => void;
  onRemove: () => void;
  onSetCombinator: (next: GroupNode["combinator"]) => void;
};

const NestedGroupRow = ({
  value,
  capabilities,
  index,
  combinator,
  onChange,
  onRemove,
  onSetCombinator,
}: NestedGroupRowProps) => {
  const t = useTranslations();
  const removeLabel = t("common.remove");

  return (
    <div className="flex items-start gap-2">
      <ConditionGutter
        combinator={combinator}
        index={index}
        onCombinator={onSetCombinator}
      />
      <div className="border-border/70 bg-muted/20 flex flex-1 items-start gap-2 rounded-md border p-2">
        <div className="flex-1">
          <ConditionBuilder
            capabilities={capabilities}
            onChange={onChange}
            value={value}
          />
        </div>
        <Button
          aria-label={removeLabel}
          onClick={onRemove}
          size="icon-xs"
          tooltip={removeLabel}
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
};

type LeafRowProps = {
  node: ConditionNode;
  capabilities: ConditionCapabilities;
  index: number;
  combinator: GroupNode["combinator"];
  onChange: (next: ConditionNode) => void;
  onRemove: () => void;
  onSetCombinator: (next: GroupNode["combinator"]) => void;
};

const LeafRow = ({
  node,
  capabilities,
  index,
  combinator,
  onChange,
  onRemove,
  onSetCombinator,
}: LeafRowProps) => {
  const t = useTranslations();
  const { fields, allowFormula = false } = capabilities;
  const operand = leafOperand(node);

  if (operand?.type === "formula") {
    const formulaOperand = operand;
    return (
      <FormulaLeafRow
        capabilities={capabilities}
        combinator={combinator}
        expr={formulaOperand.expr}
        index={index}
        node={node}
        onChange={onChange}
        onRemove={onRemove}
        onSetCombinator={onSetCombinator}
      />
    );
  }

  const opsFor = capabilities.operatorsFor ?? operatorsFor;
  const editorFor = capabilities.valueEditorFor ?? valueEditorFor;

  const fieldIndex = operand
    ? fields.findIndex((f) => operandsEqual(f.operand, operand))
    : -1;
  const field = fields[fieldIndex];

  if (!field) {
    return null;
  }

  const operator = leafOperator(node) ?? opsFor(field.valueType).at(0);

  if (!operator) {
    return null;
  }

  const operators = opsFor(field.valueType);
  const editorKind = editorFor(field.valueType, operator);

  return (
    <div className="flex items-center gap-1.5">
      <ConditionGutter
        combinator={combinator}
        index={index}
        onCombinator={onSetCombinator}
      />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Select
          onValueChange={(next) => {
            if (next === null) {
              return;
            }
            if (next === FORMULA_OPTION) {
              onChange(
                buildLeaf({
                  operand: { type: "formula", expr: "" },
                  operator: opsFor(FORMULA_VALUE_TYPE).at(0) ?? "eq",
                  value: "",
                }),
              );
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
            className="h-7 min-h-0 w-auto max-w-44 min-w-0 text-xs"
            size="sm"
          >
            <SelectValue placeholder={t("templates.conditionField")}>
              {field.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {fields.map((option, optionIndex) => (
              <SelectItem key={optionIndex} value={String(optionIndex)}>
                {option.label}
              </SelectItem>
            ))}
            {allowFormula && (
              <>
                <SelectSeparator />
                <SelectItem value={FORMULA_OPTION}>
                  {t("templates.conditionUseFormula")}
                </SelectItem>
              </>
            )}
          </SelectPopup>
        </Select>

        <OperatorSelect
          field={field}
          labelKey={capabilities.operatorLabelKey ?? operatorLabelKey}
          node={node}
          onChange={onChange}
          operator={operator}
          operators={operators}
        />

        <LeafValueEditor
          capabilities={capabilities}
          editorKind={editorKind}
          field={field}
          node={node}
          onChange={onChange}
          operator={operator}
        />
      </div>

      <RemoveButton onRemove={onRemove} />
    </div>
  );
};

type FormulaLeafRowProps = {
  node: ConditionNode;
  expr: string;
  capabilities: ConditionCapabilities;
  index: number;
  combinator: GroupNode["combinator"];
  onChange: (next: ConditionNode) => void;
  onRemove: () => void;
  onSetCombinator: (next: GroupNode["combinator"]) => void;
};

const FormulaLeafRow = ({
  node,
  expr,
  capabilities,
  index,
  combinator,
  onChange,
  onRemove,
  onSetCombinator,
}: FormulaLeafRowProps) => {
  const { fields, formulaNumberFields = [] } = capabilities;
  const opsFor = capabilities.operatorsFor ?? operatorsFor;
  const labelFor = capabilities.operatorLabelKey ?? operatorLabelKey;
  const operator =
    leafOperator(node) ?? opsFor(FORMULA_VALUE_TYPE).at(0) ?? "eq";
  const operators = opsFor(FORMULA_VALUE_TYPE);
  const firstField = fields.at(0);
  const formulaOperand = { type: "formula", expr } as const;

  return (
    <div className="flex items-center gap-1.5">
      <ConditionGutter
        combinator={combinator}
        index={index}
        onCombinator={onSetCombinator}
      />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <FormulaCell
          numberFields={formulaNumberFields}
          onChange={(nextExpr) =>
            onChange(
              buildLeaf({
                operand: { type: "formula", expr: nextExpr },
                operator,
                value: leafValueString(node),
              }),
            )
          }
          onUseField={() => {
            if (firstField) {
              onChange(leafFromField(firstField));
            }
          }}
          value={expr}
        />
        <OperatorSelectFormula
          labelKey={labelFor}
          node={node}
          onChange={onChange}
          operand={formulaOperand}
          operator={operator}
          operators={operators}
        />
        <Input
          className="h-7! w-24 text-xs"
          onChange={(e) =>
            onChange(
              buildLeaf({
                operand: formulaOperand,
                operator,
                value: e.currentTarget.value,
              }),
            )
          }
          size="sm"
          type="number"
          value={leafValueString(node)}
        />
      </div>
      <RemoveButton onRemove={onRemove} />
    </div>
  );
};

type OperatorLabelKeyFn = (
  valueType: FieldValueType,
  op: ConditionOperator,
) => OperatorLabelKey;

type OperatorSelectProps = {
  field: FieldOption;
  labelKey: OperatorLabelKeyFn;
  node: ConditionNode;
  operator: ConditionOperator;
  operators: readonly ConditionOperator[];
  onChange: (next: ConditionNode) => void;
};

const OperatorSelect = ({
  field,
  labelKey,
  node,
  operator,
  operators,
  onChange,
}: OperatorSelectProps) => {
  const t = useTranslations();
  return (
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
      <SelectTrigger className="h-7 min-h-0 w-auto min-w-24 text-xs" size="sm">
        <SelectValue>
          {() => t(labelKey(field.valueType, operator))}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {operators.map((op) => (
          <SelectItem key={op} value={op}>
            {t(labelKey(field.valueType, op))}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

type OperatorSelectFormulaProps = {
  labelKey: OperatorLabelKeyFn;
  node: ConditionNode;
  operand: { type: "formula"; expr: string };
  operator: ConditionOperator;
  operators: readonly ConditionOperator[];
  onChange: (next: ConditionNode) => void;
};

const OperatorSelectFormula = ({
  labelKey,
  node,
  operand,
  operator,
  operators,
  onChange,
}: OperatorSelectFormulaProps) => {
  const t = useTranslations();
  return (
    <Select
      onValueChange={(next) => {
        if (next === null || !isConditionOperator(next)) {
          return;
        }
        onChange(
          buildLeaf({
            operand,
            operator: next,
            value: leafValueString(node),
          }),
        );
      }}
      value={operator}
    >
      <SelectTrigger className="h-7 min-h-0 w-auto min-w-24 text-xs" size="sm">
        <SelectValue>
          {() => t(labelKey(FORMULA_VALUE_TYPE, operator))}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {operators.map((op) => (
          <SelectItem key={op} value={op}>
            {t(labelKey(FORMULA_VALUE_TYPE, op))}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

const RemoveButton = ({ onRemove }: { onRemove: () => void }) => {
  const t = useTranslations();
  return (
    <Button
      aria-label={t("common.remove")}
      onClick={onRemove}
      size="icon-xs"
      type="button"
      variant="ghost"
    >
      <XIcon />
    </Button>
  );
};

type LeafValueEditorProps = {
  capabilities: ConditionCapabilities;
  editorKind: ValueEditorKind;
  field: FieldOption;
  node: ConditionNode;
  operator: ConditionOperator;
  onChange: (next: ConditionNode) => void;
};

const LeafValueEditor = ({
  capabilities,
  editorKind,
  field,
  node,
  operator,
  onChange,
}: LeafValueEditorProps): ReactNode => {
  const t = useTranslations();

  const emit = (value: string | string[]) => {
    onChange(buildLeaf({ operand: field.operand, operator, value }));
  };

  const injected = capabilities.renderValueEditor?.({
    editorKind,
    field,
    node,
    operator,
    emit,
  });
  if (injected !== null && injected !== undefined) {
    return injected;
  }

  if (editorKind === "none") {
    return null;
  }

  if (editorKind === "select") {
    return (
      <Select
        multiple={isMultiValue(operator)}
        onValueChange={(next) => {
          if (next !== null) {
            emit(next);
          }
        }}
        value={
          isMultiValue(operator) ? leafValueList(node) : leafValueString(node)
        }
      >
        <SelectTrigger
          className="h-7 min-h-0 w-auto min-w-28 text-xs"
          size="sm"
        >
          <SelectValue placeholder={t("templates.conditionValue")} />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
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
      placeholder={t("templates.conditionValue")}
      size="sm"
      value={leafValueString(node)}
    />
  );
};
