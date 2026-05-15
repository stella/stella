import { Fragment } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { RouteIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { PropertyCondition } from "@stll/api/types";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Separator } from "@stll/ui/components/separator";

import { getTranslator } from "@/i18n/i18n-store";
import type {
  PropertyDependency,
  WorkspaceProperty,
  WorkspacePropertyOption,
} from "@/lib/types";
import { FieldValueSelect } from "@/routes/_protected.workspaces/$workspaceId/-components/field-value-select";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

type StringOperators = Extract<
  PropertyCondition,
  { type: "string" }
>["operator"];

type StringArrayOperators = Extract<
  PropertyCondition,
  { type: "string-array" }
>["operator"];

type ConditionData = {
  version: 1;
  operator: ConditionOperator;
  value: string | string[];
  options: WorkspacePropertyOption[] | undefined;
};

type ConditionOperator = PropertyCondition["operator"];

type Condition = PropertyDependency["condition"];

const getConditionData = (
  property: WorkspaceProperty | undefined,
  condition: Condition,
): ConditionData | null => {
  if (!property) {
    return null;
  }

  let defaultOperator: NonNullable<Condition>["operator"] | undefined;
  let defaultValue: NonNullable<Condition>["value"] | undefined;

  // oxlint-disable-next-line typescript/switch-exhaustiveness-check
  switch (property.content.type) {
    case "text":
    case "single-select":
      defaultValue = "";
      defaultOperator = "eq";
      break;
    case "multi-select":
      defaultValue = [];
      defaultOperator = "contains-every";
      break;
    default:
      defaultValue = undefined;
      defaultOperator = undefined;
      break;
  }

  if (defaultValue === undefined || defaultOperator === undefined) {
    return null;
  }

  return {
    version: 1,
    operator: condition?.operator ?? defaultOperator,
    value: condition?.value ?? defaultValue,
    options:
      "options" in property.content ? property.content.options : undefined,
  };
};

type PropertyConditionsProps = {
  workspaceId: string;
  dependencies: PropertyDependency[];
  replaceValue: (index: number, value: PropertyDependency) => void;
};

export const PropertyConditions = ({
  workspaceId,
  dependencies,
  replaceValue,
}: PropertyConditionsProps) => {
  const t = useTranslations();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));

  const data = dependencies
    .map((dependency) => {
      const property = properties.find(
        (p) => p.id === dependency.dependsOnPropertyId,
      );
      const conditionData = getConditionData(property, dependency.condition);

      if (!property || !conditionData) {
        return null;
      }

      return { property, conditionData };
    })
    .filter(
      (condition): condition is NonNullable<typeof condition> =>
        condition !== null,
    );

  const conditionCount = dependencies.filter(
    (dependency) => dependency.condition !== null,
  ).length;

  if (data.length === 0) {
    return null;
  }

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            className="w-full justify-start font-semibold"
            variant="ghost"
          />
        }
      >
        <RouteIcon />{" "}
        {t("workspaces.properties.conditions", {
          count: String(conditionCount),
        })}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("workspaces.properties.editConditions")}</DialogTitle>
          <p className="text-muted-foreground text-sm">
            {t("workspaces.properties.editConditionsDescription")}
          </p>
        </DialogHeader>
        <ScrollArea className="h-96">
          <DialogPanel>
            {data.map(({ property, conditionData }) => (
              <Fragment key={property.id}>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 py-2 first:hidden">
                  <Separator />
                  <span className="text-muted-foreground text-xs font-medium">
                    {t("workspaces.properties.conditionSeparator")}
                  </span>
                  <Separator />
                </div>
                <ConditionRow
                  data={conditionData}
                  onConditionChange={(condition) => {
                    const index = dependencies.findIndex(
                      (d) => d.dependsOnPropertyId === property.id,
                    );

                    if (index === -1) {
                      return;
                    }
                    replaceValue(index, {
                      dependsOnPropertyId: property.id,
                      condition,
                    });
                  }}
                  property={property}
                />
              </Fragment>
            ))}
          </DialogPanel>
        </ScrollArea>
      </DialogPopup>
    </Dialog>
  );
};

const getOperatorLabels = (): Record<ConditionOperator, string> => {
  const t = getTranslator();
  return {
    eq: t("workspaces.operators.equals"),
    "contains-every": t("workspaces.operators.containsEvery"),
  };
};

const STRING_OPERATORS: StringOperators[] = ["eq"];
const STRING_ARRAY_OPERATORS: StringArrayOperators[] = ["contains-every"];

const getOperatorOptions = (
  value: string | string[],
  operatorLabels: Record<ConditionOperator, string>,
) => {
  let operatorKeys: ConditionOperator[] = [];
  if (typeof value === "string") {
    operatorKeys = STRING_OPERATORS;
  } else if (Array.isArray(value)) {
    operatorKeys = STRING_ARRAY_OPERATORS;
  }

  return operatorKeys.map((operator) => ({
    value: operator,
    label: operatorLabels[operator],
  }));
};

type BuildConditionArgs = {
  operator: ConditionOperator;
  value: string | string[] | null;
};

const buildCondition = ({
  operator,
  value,
}: BuildConditionArgs): PropertyCondition | null => {
  if (Array.isArray(value) && operator === "contains-every") {
    return value.length > 0
      ? {
          version: 1,
          type: "string-array",
          operator,
          value,
        }
      : null;
  }

  if (typeof value === "string" && operator === "eq") {
    return value.trim().length > 0
      ? {
          version: 1,
          type: "string",
          operator,
          value: value.trim(),
        }
      : null;
  }

  return null;
};

type ConditionRowProps = {
  property: WorkspaceProperty;
  data: NonNullable<ReturnType<typeof getConditionData>>;
  onConditionChange: (condition: PropertyCondition | null) => void;
};

const ConditionRow = ({
  property,
  data,
  onConditionChange,
}: ConditionRowProps) => {
  const t = useTranslations();
  const operatorLabels = getOperatorLabels();
  const operatorOptions = getOperatorOptions(data.value, operatorLabels);

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center gap-x-1.5">
        <PropertyIcon type={property.content.type} />{" "}
        <span className="text-sm font-medium">{property.name}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          items={operatorOptions}
          onValueChange={(newValue) => {
            if (newValue) {
              onConditionChange(
                buildCondition({ operator: newValue, value: data.value }),
              );
            }
          }}
          value={data.operator}
        >
          <SelectTrigger>
            <SelectValue className="truncate">
              {(selected) =>
                operatorOptions.find((o) => o.value === selected)?.label ??
                t("workspaces.properties.selectOperator")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {operatorOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {typeof data.value === "string" && !data.options && (
          <Input
            onChange={(e) =>
              onConditionChange(
                buildCondition({
                  operator: data.operator,
                  value: e.target.value,
                }),
              )
            }
            placeholder={t("workspaces.properties.enterAValue")}
            value={data.value}
          />
        )}
        {data.options && typeof data.value === "string" && (
          <FieldValueSelect
            onChange={(value) => {
              onConditionChange(
                buildCondition({ operator: data.operator, value }),
              );
            }}
            options={data.options}
            type="single-select"
            value={data.value}
          />
        )}
        {data.options && Array.isArray(data.value) && (
          <FieldValueSelect
            onChange={(value) => {
              onConditionChange(
                buildCondition({ operator: data.operator, value }),
              );
            }}
            options={data.options}
            type="multi-select"
            value={data.value}
          />
        )}
      </div>
    </div>
  );
};
