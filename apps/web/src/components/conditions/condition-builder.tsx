import type { ComponentProps } from "react";

import { useTranslations } from "use-intl";

import type { ConditionBuilderLabels } from "@stll/workspace-ui/conditions";
import { ConditionBuilder as WorkspaceConditionBuilder } from "@stll/workspace-ui/conditions";

import { operatorLabelKey } from "@/components/conditions/condition-builder-logic";
import { FormulaCell } from "@/components/conditions/formula-editor";
import { useLocale } from "@/i18n/formatting-context";

export type {
  ConditionCapabilities,
  ValueEditorRenderCtx,
} from "@stll/workspace-ui/conditions";

type WorkspaceBuilderProps = ComponentProps<typeof WorkspaceConditionBuilder>;

type ConditionBuilderProps = Omit<
  WorkspaceBuilderProps,
  "labels" | "locale"
> & {
  /** The "+ Add condition" wording; the two surfaces word it differently. */
  addConditionLabel?: string | undefined;
  /** Relabel operators per value type (the template surface words them
   *  friendlier). Defaults to this app's operator catalogue. */
  operatorLabel?: ConditionBuilderLabels["operator"] | undefined;
};

/**
 * The app's condition builder: the workspace kit's, with this app's catalogue
 * and formatting locale, and its formula editor plugged into the slot the kit
 * leaves for it.
 */
export const ConditionBuilder = ({
  addConditionLabel,
  operatorLabel,
  capabilities,
  ...props
}: ConditionBuilderProps) => {
  const t = useTranslations();
  const locale = useLocale();

  const labels: ConditionBuilderLabels = {
    addCondition: addConditionLabel ?? t("templates.conditionAddRule"),
    addGroup: t("templates.conditionAddGroup"),
    when: t("templates.conditionWhen"),
    match: t("templates.conditionMatch"),
    and: t("templates.conditionAnd"),
    or: t("templates.conditionOr"),
    remove: t("common.remove"),
    fieldPlaceholder: t("templates.conditionField"),
    valuePlaceholder: t("common.value"),
    useFormula: t("templates.conditionUseFormula"),
    clearDate: t("common.clearDate"),
    selectDate: t("common.selectDate"),
    today: t("common.today"),
    operator:
      operatorLabel ??
      ((valueType, operator) => t(operatorLabelKey(valueType, operator))),
  };

  return (
    <WorkspaceConditionBuilder
      {...props}
      capabilities={{
        ...capabilities,
        renderFormulaCell: ({
          expr,
          numberFields,
          onChangeExpr,
          onUseField,
        }) => (
          <FormulaCell
            numberFields={numberFields}
            onChange={onChangeExpr}
            onUseField={onUseField}
            value={expr}
          />
        ),
      }}
      labels={labels}
      locale={locale}
    />
  );
};
