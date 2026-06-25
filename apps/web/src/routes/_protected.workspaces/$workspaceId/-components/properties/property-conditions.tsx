import { Fragment, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { RouteIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { ConditionNode } from "@stll/conditions";
import { pruneIncomplete } from "@stll/conditions";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Separator } from "@stll/ui/components/separator";

import { ConditionBuilder } from "@/components/conditions/condition-builder";
import type { FieldOption } from "@/components/conditions/condition-builder-logic";
import type { PropertyDependency, WorkspaceProperty } from "@/lib/types";
import { filterCapabilities } from "@/routes/_protected.workspaces/$workspaceId/-components/conditions/filter-capabilities";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

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

  const editableDependencies = dependencies
    .map((dependency, index) => {
      const property = properties.find(
        (p) => p.id === dependency.dependsOnPropertyId,
      );
      const field = property ? fieldOptionFor(property) : null;

      if (!property || !field) {
        return null;
      }

      return { dependency, field, index, property };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const conditionCount = dependencies.filter(
    (dependency) => dependency.condition !== null,
  ).length;

  if (editableDependencies.length === 0) {
    return null;
  }

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            className="w-full justify-start font-normal"
            size="sm"
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
            {editableDependencies.map(
              ({ dependency, field, index, property }) => (
                <Fragment key={property.id}>
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 py-2 first:hidden">
                    <Separator />
                    <span className="text-muted-foreground text-xs font-medium">
                      {t("workspaces.properties.conditionSeparator")}
                    </span>
                    <Separator />
                  </div>
                  <DependencyConditionEditor
                    dependency={dependency}
                    field={field}
                    index={index}
                    onPersist={replaceValue}
                    property={property}
                  />
                </Fragment>
              ),
            )}
          </DialogPanel>
        </ScrollArea>
      </DialogPopup>
    </Dialog>
  );
};

type DependencyConditionEditorProps = {
  dependency: PropertyDependency;
  field: FieldOption;
  index: number;
  property: WorkspaceProperty;
  onPersist: (index: number, value: PropertyDependency) => void;
};

/**
 * Edits one dependency's gate. The builder is controlled and the parent
 * persists on every change, so we hold the in-progress group locally
 * (incomplete leaves and all) and persist only the pruned condition. A
 * half-entered leaf would otherwise be saved as a live gate and then vanish
 * from the editor on the next render. An all-incomplete group prunes to
 * `null` ("no gate"), matching the gating evaluator and the SQL compiler.
 */
const DependencyConditionEditor = ({
  dependency,
  field,
  index,
  property,
  onPersist,
}: DependencyConditionEditorProps) => {
  const t = useTranslations();
  const [draft, setDraft] = useState<ConditionNode | null>(
    dependency.condition,
  );

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center gap-x-1.5">
        <PropertyIcon type={property.content.type} />
        <span className="text-sm font-medium">{property.name}</span>
      </div>
      <p className="text-muted-foreground text-xs">
        {t("workspaces.properties.editConditionsWhen")}
      </p>
      <ConditionBuilder
        capabilities={filterCapabilities({ fields: [field] })}
        onChange={(next) => {
          setDraft(next);
          onPersist(index, {
            dependsOnPropertyId: property.id,
            condition: pruneIncomplete(next),
          });
        }}
        value={draft}
      />
    </div>
  );
};

/** Maps a gateable dependency property to a builder field, or null. */
const fieldOptionFor = (property: WorkspaceProperty): FieldOption | null => {
  const { content } = property;

  if (content.type === "file") {
    return null;
  }

  if (content.type === "single-select" || content.type === "multi-select") {
    return {
      operand: { type: "property", propertyId: property.id },
      label: property.name,
      valueType: content.type,
      type: content.type,
      options: content.options.map((option) => ({
        value: option.value,
        label: option.value,
        color: option.color,
      })),
    };
  }

  return {
    operand: { type: "property", propertyId: property.id },
    label: property.name,
    valueType: content.type,
    type: content.type,
  };
};
