import { createContext, use } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { PlusIcon, XIcon } from "lucide-react";

import type { ConditionNode, GroupNode } from "@stll/conditions";
import { Button } from "@stll/ui/button";
import { DatePickerPopover } from "@stll/ui/date-picker-popover";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { cn } from "@stll/ui/utils";

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
  operatorsFor,
  removeChild,
  replaceChild,
  type ValueEditorKind,
  valueEditorFor,
} from "./logic";

/**
 * Every string the builder draws. The module resolves none of them: a host
 * brings its own catalogue, and an exported module that reached into one would
 * only work inside the app whose messages it happened to know.
 */
export type ConditionBuilderLabels = {
  /** "+ Add condition". */
  addCondition: string;
  /** "+ Add group". */
  addGroup: string;
  /** Leads the first row: "When". */
  when: string;
  /** Accessible name of the and/or select. */
  match: string;
  and: string;
  or: string;
  /** Removes one row or group. */
  remove: string;
  /** Placeholder in the field select. */
  fieldPlaceholder: string;
  /** Placeholder in the value editor. */
  valuePlaceholder: string;
  /** The "ƒ Calculated value…" item. */
  useFormula: string;
  /** The date editor's own three. */
  clearDate: string;
  selectDate: string;
  today: string;
  /** How an operator reads for a given value type. */
  operator: (valueType: FieldValueType, op: ConditionOperator) => string;
};

type ConditionBuilderContextValue = {
  labels: ConditionBuilderLabels;
  /** Formatting locale for the date editor. */
  locale: string;
};

const BuilderContext = createContext<ConditionBuilderContextValue | null>(null);

/**
 * A context rather than a prop on every row because the builder is recursive:
 * threading one object through six nested components would put it in every
 * signature and still arrive at the same leaf.
 */
const useBuilderContext = (): ConditionBuilderContextValue => {
  const context = use(BuilderContext);
  if (!context) {
    panic("ConditionBuilder rendered outside its own provider");
  }
  return context;
};

const useLabels = (): ConditionBuilderLabels => useBuilderContext().labels;

/** Capability flags and host injections that let one recursive builder serve
 *  both the View filter surface and the template rule surface. The host owns
 *  the field list and (optionally) the value editors; the builder owns the
 *  tree shape, the gutter, nesting, and the formula escape hatch. */
export type ConditionCapabilities = {
  /** Operands the picker may target (property / builtin / kind / path). */
  fields: FieldOption[];
  /** Allow nested groups (the "+ Add group" affordance + bordered subgroups). */
  allowNesting?: boolean;
  /**
   * How many children the caller's backend accepts in one group. The add
   * affordances are disabled at the cap, so a tree cannot be edited into a
   * shape the server would reject. Omitted means no cap.
   */
  maxChildren?: number | undefined;
  /** Offer a "ƒ Calculated value…" item that switches a leaf's left operand to
   *  a formula edited via `FormulaCell`. */
  allowFormula?: boolean;
  /** Numeric operands a formula leaf may reference; required for `allowFormula`. */
  formulaNumberFields?: readonly { path: string; label: string }[];
  /** Host-injected value editor (e.g. faceted selects). Return null to fall back
   *  to the builder's built-in editor for that kind. */
  renderValueEditor?: (ctx: ValueEditorRenderCtx) => React.ReactNode | null;
  /** Draws the formula cell for a formula leaf; required for `allowFormula`. */
  renderFormulaCell?: (ctx: FormulaCellRenderCtx) => ReactNode;
  /** Restrict the operator set per value type (e.g. the template surface only
   *  exposes operators its serializer can render). Defaults to the logic's
   *  `operatorsFor`. */
  operatorsFor?: (valueType: FieldValueType) => readonly ConditionOperator[];
  /** Override how a value type renders its value editor. Defaults to the logic's
   *  `valueEditorFor`. */
  valueEditorFor?: (
    valueType: FieldValueType,
    op: ConditionOperator,
  ) => ValueEditorKind;
};

/**
 * The formula editor is a slot: its expression language belongs to the host,
 * so the builder hands it the expression and takes back either a new one or a
 * request to go back to an ordinary field. Rebuilding the leaf stays here,
 * because that is AST work.
 */
export type FormulaCellRenderCtx = {
  expr: string;
  numberFields: readonly { path: string; label: string }[];
  onChangeExpr: (expr: string) => void;
  onUseField: () => void;
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
  labels: ConditionBuilderLabels;
  /** Formatting locale for the date editor. */
  locale: string;
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
  labels,
  locale,
}: ConditionBuilderProps) => (
  <BuilderContext value={{ labels, locale }}>
    <ConditionBuilderTree
      capabilities={capabilities}
      onChange={onChange}
      value={value}
    />
  </BuilderContext>
);

type ConditionBuilderTreeProps = Omit<
  ConditionBuilderProps,
  "labels" | "locale"
>;

const ConditionBuilderTree = ({
  value,
  onChange,
  capabilities,
}: ConditionBuilderTreeProps) => {
  const labels = useLabels();
  const group = asGroup(value);
  const { fields, allowNesting = false, maxChildren } = capabilities;
  const firstField = fields.at(0);
  const atChildCap =
    maxChildren !== undefined && group.children.length >= maxChildren;
  const canAdd = firstField !== undefined && !atChildCap;

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
                // eslint-disable-next-line react/no-array-index-key -- ConditionNode has no stable id (nodes are plain value objects recreated on every edit via replaceChild/buildLeaf); rows are fully controlled by the `value`/`node` prop with no internal state, so index-keyed reuse never mismatches rendered content.
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
              // eslint-disable-next-line react/no-array-index-key -- ConditionNode has no stable id (nodes are plain value objects recreated on every edit via replaceChild/buildLeaf); rows are fully controlled by the `node` prop with no internal state, so index-keyed reuse never mismatches rendered content.
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
          disabled={!canAdd}
          onClick={() => {
            if (firstField && !atChildCap) {
              onChange(appendChild(group, leafFromField(firstField)));
            }
          }}
          size="xs"
          type="button"
          variant="ghost"
        >
          <PlusIcon />
          {labels.addCondition}
        </Button>
        {allowNesting && (
          <Button
            className="w-fit justify-start"
            disabled={!canAdd}
            onClick={() => {
              if (firstField && !atChildCap) {
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
            {labels.addGroup}
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
  const labels = useLabels();
  const gutterClass = "w-20 shrink-0 text-muted-foreground text-xs";

  if (index === 0) {
    return <span className={cn(gutterClass, "ps-1")}>{labels.when}</span>;
  }
  if (index === 1) {
    return (
      <Select
        onValueChange={(next) => onCombinator(next === "or" ? "or" : "and")}
        value={combinator}
      >
        <SelectTrigger
          aria-label={labels.match}
          className="h-7 min-h-0 w-20 min-w-0 shrink-0 text-xs"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="and">{labels.and}</SelectItem>
          <SelectItem value="or">{labels.or}</SelectItem>
        </SelectPopup>
      </Select>
    );
  }
  return (
    <span className={cn(gutterClass, "ps-1")}>
      {combinator === "or" ? labels.or : labels.and}
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
  const labels = useLabels();
  const removeLabel = labels.remove;

  return (
    <div className="flex items-start gap-2">
      <ConditionGutter
        combinator={combinator}
        index={index}
        onCombinator={onSetCombinator}
      />
      <div className="border-border/70 bg-muted/20 flex flex-1 items-start gap-2 rounded-md border p-2">
        <div className="flex-1">
          <ConditionBuilderTree
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
  const labels = useLabels();
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
            className="h-7 min-h-0 w-auto max-w-56 text-xs"
            size="sm"
          >
            <SelectValue placeholder={labels.fieldPlaceholder}>
              {field.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {fields.map((option, optionIndex) => (
              <SelectItem
                key={JSON.stringify(option.operand)}
                value={String(optionIndex)}
              >
                {option.label}
              </SelectItem>
            ))}
            {allowFormula && (
              <>
                <SelectSeparator />
                <SelectItem value={FORMULA_OPTION}>
                  {labels.useFormula}
                </SelectItem>
              </>
            )}
          </SelectPopup>
        </Select>

        <OperatorSelect
          field={field}
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
  const labels = useLabels();
  const { fields, formulaNumberFields = [] } = capabilities;
  const opsFor = capabilities.operatorsFor ?? operatorsFor;
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
        {capabilities.renderFormulaCell?.({
          expr,
          numberFields: formulaNumberFields,
          onChangeExpr: (nextExpr) =>
            onChange(
              buildLeaf({
                operand: { type: "formula", expr: nextExpr },
                operator,
                value: leafValueString(node),
              }),
            ),
          onUseField: () => {
            if (firstField) {
              onChange(leafFromField(firstField));
            }
          },
        })}
        <OperatorSelectFormula
          node={node}
          onChange={onChange}
          operand={formulaOperand}
          operator={operator}
          operators={operators}
        />
        <Input
          aria-label={labels.valuePlaceholder}
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
          placeholder={labels.valuePlaceholder}
          size="sm"
          type="number"
          value={leafValueString(node)}
        />
      </div>
      <RemoveButton onRemove={onRemove} />
    </div>
  );
};

type OperatorSelectProps = {
  field: FieldOption;
  node: ConditionNode;
  operator: ConditionOperator;
  operators: readonly ConditionOperator[];
  onChange: (next: ConditionNode) => void;
};

const OperatorSelect = ({
  field,
  node,
  operator,
  operators,
  onChange,
}: OperatorSelectProps) => {
  const labels = useLabels();
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
          {() => labels.operator(field.valueType, operator)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {operators.map((op) => (
          <SelectItem key={op} value={op}>
            {labels.operator(field.valueType, op)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

type OperatorSelectFormulaProps = {
  node: ConditionNode;
  operand: { type: "formula"; expr: string };
  operator: ConditionOperator;
  operators: readonly ConditionOperator[];
  onChange: (next: ConditionNode) => void;
};

const OperatorSelectFormula = ({
  node,
  operand,
  operator,
  operators,
  onChange,
}: OperatorSelectFormulaProps) => {
  const labels = useLabels();
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
          {() => labels.operator(FORMULA_VALUE_TYPE, operator)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {operators.map((op) => (
          <SelectItem key={op} value={op}>
            {labels.operator(FORMULA_VALUE_TYPE, op)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

const RemoveButton = ({ onRemove }: { onRemove: () => void }) => {
  const labels = useLabels();
  return (
    <Button
      aria-label={labels.remove}
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
  const { labels, locale } = useBuilderContext();

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
          <SelectValue placeholder={labels.valuePlaceholder} />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {field.options?.map((option) => (
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
        aria-label={labels.valuePlaceholder}
        className="h-7! w-24 text-xs"
        onChange={(e) => emit(e.currentTarget.value)}
        placeholder={labels.valuePlaceholder}
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
          clearLabel={labels.clearDate}
          locale={locale}
          onChange={(next) => emit(next ?? "")}
          placeholderLabel={labels.selectDate}
          todayLabel={labels.today}
          value={leafValueString(node) || null}
        />
      </div>
    );
  }

  return (
    <Input
      aria-label={labels.valuePlaceholder}
      className="h-7! w-32 text-xs"
      onChange={(e) => emit(e.currentTarget.value)}
      placeholder={labels.valuePlaceholder}
      size="sm"
      value={leafValueString(node)}
    />
  );
};
