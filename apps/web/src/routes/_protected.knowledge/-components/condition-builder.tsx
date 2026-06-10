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

const OPERATORS: ConditionOperator[] = ["==", "!=", ">", "<", ">=", "<="];

const isConditionOperator = (value: string): value is ConditionOperator =>
  OPERATORS.some((op) => op === value);

const emptyRule = (): ConditionRule => ({
  kind: "rule",
  variable: "",
  operator: "==",
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
  fields: readonly string[];
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
        <div className="flex items-center gap-2" key={index}>
          <select
            aria-label={t("templates.conditionField")}
            className={`${inputClass} min-w-32 flex-1`}
            onChange={(e) => setRule(index, { variable: e.target.value })}
            value={rule.variable}
          >
            <option value="">{t("templates.conditionField")}</option>
            {fields.map((field) => (
              <option key={field} value={field}>
                {field}
              </option>
            ))}
          </select>
          <select
            aria-label={t("templates.conditionOperator")}
            className={inputClass}
            onChange={(e) => {
              if (isConditionOperator(e.target.value)) {
                setRule(index, { operator: e.target.value });
              }
            }}
            value={rule.operator}
          >
            {OPERATORS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <Input
            aria-label={t("templates.conditionValue")}
            className="w-28"
            onChange={(e) => setRule(index, { value: e.target.value })}
            placeholder={t("templates.conditionValue")}
            value={String(rule.value)}
          />
          <Button
            disabled={rules.length === 1}
            onClick={() =>
              onChange({
                ...group,
                children: rules.filter((_, i) => i !== index),
              })
            }
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <TrashIcon />
          </Button>
        </div>
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

// ── Named conditions list (wizard section) ───────────────

export const NamedConditionsEditor = ({
  fields,
  conditions,
  onChange,
}: {
  fields: readonly string[];
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
