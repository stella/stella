import { PlusIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  type ConditionGroup,
  type ConditionOperator,
  type ConditionRule,
  serializeCondition,
} from "@stll/template-conditions";
import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";

import { DatePickerPopover } from "@/components/date-picker-popover";
import type { TranslationKey } from "@/i18n/types";

/** The subset of a template field the rule builder needs to render a typed
 *  row. `inputType` drives the operator set and value control; `options` feed
 *  a select's value dropdown. Built by the caller from its richer field model;
 *  boolean fields are the yes/no question path and are excluded upstream. */
export type RuleField = {
  path: string;
  label: string;
  inputType: "text" | "textarea" | "number" | "date" | "select";
  options: readonly string[];
};

type RuleInputType = RuleField["inputType"];

/** Source field shape both callers already have. Boolean fields are the yes/no
 *  question path and are dropped here, so the rule builder never offers them. */
type SourceField = {
  path: string;
  label: string;
  inputType: RuleInputType | "boolean";
  options: readonly string[];
};

const isRuleField = (
  field: SourceField,
): field is SourceField & { inputType: RuleInputType } =>
  field.inputType !== "boolean";

/** Project a caller's editable fields onto the rule builder's `RuleField`
 *  shape, excluding boolean (question) fields. */
export const toRuleFields = (
  fields: readonly SourceField[],
): readonly RuleField[] =>
  fields.filter(isRuleField).map((f) => ({
    path: f.path,
    label: f.label,
    inputType: f.inputType,
    options: f.options,
  }));

/** Operator-label keys, narrowed against the catalogue. All are plain (no ICU
 *  arguments), so `t(labelKey)` is callable with a single argument. */
type OperatorLabelKey = TranslationKey &
  (
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
  );

/** A friendly operator label mapped to the canonical engine operator that
 *  `serializeCondition` emits. */
type OperatorChoice = {
  operator: ConditionOperator;
  labelKey: OperatorLabelKey;
};

// Per-type operator menus. The canonical operator strings are unchanged; only
// the labels and the offered set adapt to the field's type. The first entry is
// the default operator for that type.
const TEXT_OPERATORS: readonly OperatorChoice[] = [
  { operator: "==", labelKey: "templates.conditionOpIs" },
  { operator: "!=", labelKey: "templates.conditionOpIsNot" },
  { operator: "contains", labelKey: "templates.conditionOpContains" },
];

const NUMBER_OPERATORS: readonly OperatorChoice[] = [
  { operator: "==", labelKey: "templates.conditionOpEquals" },
  { operator: "!=", labelKey: "templates.conditionOpNotEquals" },
  { operator: ">", labelKey: "templates.conditionOpGreaterThan" },
  { operator: "<", labelKey: "templates.conditionOpLessThan" },
  { operator: ">=", labelKey: "templates.conditionOpAtLeast" },
  { operator: "<=", labelKey: "templates.conditionOpAtMost" },
];

const DATE_OPERATORS: readonly OperatorChoice[] = [
  { operator: "<", labelKey: "templates.conditionOpBefore" },
  { operator: "<=", labelKey: "templates.conditionOpOnOrBefore" },
  { operator: "==", labelKey: "templates.conditionOpOn" },
  { operator: ">=", labelKey: "templates.conditionOpOnOrAfter" },
  { operator: ">", labelKey: "templates.conditionOpAfter" },
];

const SELECT_OPERATORS: readonly OperatorChoice[] = [
  { operator: "==", labelKey: "templates.conditionOpIs" },
  { operator: "!=", labelKey: "templates.conditionOpIsNot" },
  { operator: "contains", labelKey: "templates.conditionOpContains" },
];

const operatorsForType = (
  inputType: RuleInputType,
): readonly OperatorChoice[] => {
  switch (inputType) {
    case "number":
      return NUMBER_OPERATORS;
    case "date":
      return DATE_OPERATORS;
    case "select":
      return SELECT_OPERATORS;
    default:
      return TEXT_OPERATORS;
  }
};

/** Default operator when no field is chosen, matching the canonical default. */
const DEFAULT_OPERATOR: ConditionOperator = "==";

const defaultOperatorForType = (
  inputType: RuleInputType,
): ConditionOperator => {
  const first = operatorsForType(inputType).at(0);
  return first ? first.operator : DEFAULT_OPERATOR;
};

const emptyRule = (): ConditionRule => ({
  kind: "rule",
  variable: "",
  operator: DEFAULT_OPERATOR,
  value: "",
});

/** A reusable named condition built in the wizard, e.g. NPF = `npf == true`. */
export type DraftCondition = {
  id: string;
  name: string;
  group: ConditionGroup;
};

export const emptyGroup = (): ConditionGroup => ({
  kind: "group",
  match: "all",
  children: [emptyRule()],
});

/**
 * Convert a draft condition into a NamedCondition the manifest stores, or
 * `null` when it has no name or no usable rules (so callers can drop it).
 */
export const draftToNamedCondition = (
  draft: DraftCondition,
): { name: string; expression: string } | null => {
  const name = draft.name.trim();
  if (!name) {
    return null;
  }
  const expression = serializeCondition(draft.group);
  if (!expression) {
    return null;
  }
  return { name, expression };
};

const inputClass =
  "flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm";

// ── Flat all/any rule editor ─────────────────────────────

export const ConditionGroupEditor = ({
  fields,
  group,
  onChange,
}: {
  fields: readonly RuleField[];
  group: ConditionGroup;
  onChange: (group: ConditionGroup) => void;
}) => {
  const t = useTranslations();
  const rules = group.children.filter(
    (child): child is ConditionRule => child.kind === "rule",
  );

  const setRule = (index: number, patch: Partial<ConditionRule>) => {
    const next = rules.map((rule, i) =>
      i === index ? { ...rule, ...patch } : rule,
    );
    onChange({ ...group, children: next });
  };

  // Changing the field can change its type, which changes the valid operator
  // set and value control. Reset the operator to the new type's default and
  // clear a value that no longer fits the new control.
  const setField = (index: number, path: string) => {
    const nextType = fields.find((f) => f.path === path)?.inputType;
    const prevType = fields.find(
      (f) => f.path === rules[index]?.variable,
    )?.inputType;
    if (nextType === undefined || nextType === prevType) {
      setRule(index, { variable: path });
      return;
    }
    setRule(index, {
      variable: path,
      operator: defaultOperatorForType(nextType),
      value: "",
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <select
          aria-label={t("templates.conditionMatch")}
          className={inputClass}
          onChange={(e) =>
            onChange({
              ...group,
              match: e.target.value === "any" ? "any" : "all",
            })
          }
          value={group.match}
        >
          <option value="all">{t("templates.conditionMatchAll")}</option>
          <option value="any">{t("templates.conditionMatchAny")}</option>
        </select>
        <span className="text-muted-foreground">
          {t("templates.conditionMatchSuffix")}
        </span>
      </div>

      {rules.map((rule, index) => (
        // Rules have no stable id; index key is fine for this small, local list.
        <RuleRow
          fields={fields}
          key={index}
          onRemove={() =>
            onChange({
              ...group,
              children: rules.filter((_, i) => i !== index),
            })
          }
          onSetField={(path) => setField(index, path)}
          onSetRule={(patch) => setRule(index, patch)}
          removable={rules.length > 1}
          rule={rule}
        />
      ))}

      <Button
        className="self-start"
        onClick={() =>
          onChange({ ...group, children: [...rules, emptyRule()] })
        }
        size="sm"
        type="button"
        variant="outline"
      >
        <PlusIcon />
        {t("templates.conditionAddRule")}
      </Button>
    </div>
  );
};

// ── One field | operator | value row ─────────────────────

const RuleRow = ({
  fields,
  rule,
  removable,
  onSetField,
  onSetRule,
  onRemove,
}: {
  fields: readonly RuleField[];
  rule: ConditionRule;
  removable: boolean;
  onSetField: (path: string) => void;
  onSetRule: (patch: Partial<ConditionRule>) => void;
  onRemove: () => void;
}) => {
  const t = useTranslations();
  const selected = fields.find((f) => f.path === rule.variable);
  const inputType = selected?.inputType ?? "text";
  const operators = operatorsForType(inputType);

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={t("templates.conditionField")}
        className={`${inputClass} min-w-32 flex-1`}
        onChange={(e) => onSetField(e.target.value)}
        value={rule.variable}
      >
        <option value="">{t("templates.conditionField")}</option>
        {fields.map((field) => (
          <option key={field.path} value={field.path}>
            {field.label || field.path}
          </option>
        ))}
      </select>
      <select
        aria-label={t("templates.conditionOperator")}
        className={inputClass}
        onChange={(e) => {
          const choice = operators.find((o) => o.operator === e.target.value);
          if (choice) {
            onSetRule({ operator: choice.operator });
          }
        }}
        value={rule.operator}
      >
        {operators.map((choice) => (
          <option key={choice.operator} value={choice.operator}>
            {t(choice.labelKey)}
          </option>
        ))}
      </select>
      <RuleValueInput
        field={selected}
        onChange={(value) => onSetRule({ value })}
        value={rule.value}
      />
      <Button
        disabled={!removable}
        onClick={onRemove}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <TrashIcon />
      </Button>
    </div>
  );
};

// ── Value control, typed to the selected field ───────────

const RuleValueInput = ({
  field,
  value,
  onChange,
}: {
  field: RuleField | undefined;
  value: string | number | boolean;
  onChange: (value: string) => void;
}) => {
  const t = useTranslations();
  const stringValue = String(value);

  if (field?.inputType === "select") {
    return (
      <select
        aria-label={t("templates.conditionValue")}
        className={`${inputClass} w-28`}
        onChange={(e) => onChange(e.target.value)}
        value={stringValue}
      >
        <option value="">{t("templates.conditionValue")}</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (field?.inputType === "date") {
    return (
      <DatePickerPopover
        onChange={(v) => onChange(v ?? "")}
        value={stringValue}
      />
    );
  }

  if (field?.inputType === "number") {
    return (
      <Input
        aria-label={t("templates.conditionValue")}
        className="w-28"
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("templates.conditionValue")}
        type="number"
        value={stringValue}
      />
    );
  }

  return (
    <Input
      aria-label={t("templates.conditionValue")}
      className="w-28"
      onChange={(e) => onChange(e.target.value)}
      placeholder={t("templates.conditionValue")}
      value={stringValue}
    />
  );
};

// ── Named conditions list (wizard section) ───────────────

export const NamedConditionsEditor = ({
  fields,
  conditions,
  onChange,
}: {
  fields: readonly RuleField[];
  conditions: DraftCondition[];
  onChange: (conditions: DraftCondition[]) => void;
}) => {
  const t = useTranslations();

  const update = (id: string, patch: Partial<DraftCondition>) =>
    onChange(conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  return (
    <div className="flex flex-col gap-4">
      {conditions.map((condition) => (
        <div
          className="flex flex-col gap-2 rounded-lg border p-3"
          key={condition.id}
        >
          <div className="flex items-center gap-2">
            <Input
              className="flex-1"
              onChange={(e) => update(condition.id, { name: e.target.value })}
              placeholder={t("templates.conditionNamePlaceholder")}
              value={condition.name}
            />
            <Button
              onClick={() =>
                onChange(conditions.filter((c) => c.id !== condition.id))
              }
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <TrashIcon />
            </Button>
          </div>
          <ConditionGroupEditor
            fields={fields}
            group={condition.group}
            onChange={(group) => update(condition.id, { group })}
          />
        </div>
      ))}
    </div>
  );
};
