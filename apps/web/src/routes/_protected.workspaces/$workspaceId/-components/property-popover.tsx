import { useState } from "react";

import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import type { OptionColor } from "@stll/api/types";
import { Button } from "@stll/ui/components/button";
import { FieldError } from "@stll/ui/components/field";
import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { Separator } from "@stll/ui/components/separator";
import { toastManager } from "@stll/ui/components/toast";
import { revalidateLogic, useForm, useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { EyeOffIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import type { _Translator as Translator } from "use-intl/core";
import * as v from "valibot";

import { requiredTrimmedStringSchema, toFormErrors } from "@/lib/schema";
import type { WorkspaceProperty } from "@/lib/types";
import { DeleteProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/delete-property";
import { PropertyTextInput } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/form";
import { PinProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/pin-property";
import { PropertyConditions } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-conditions";
import { PropertyPromptInput } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import { validatePropertyInputs } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/validate-inputs";
import { SelectFallback } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/select-fallback";
import { SelectOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/select-options";
import { SelectTool } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/select-tool";
import {
  PropertyPopoverTrigger,
  PropertyPopoverType,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import {
  SortProperty,
  toSortHint,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/sort-property";
import { getEntityIdsOrderFromRows } from "@/routes/_protected.workspaces/$workspaceId/-components/property-popover.logic";
import type { TableHeader } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import { useUpdateProperty } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

const getVString = (t: Translator) =>
  requiredTrimmedStringSchema(t("common.required"));

const getDependencyCondition = (t: Translator) => {
  const vStr = getVString(t);
  return v.variant("type", [
    v.strictObject({
      version: v.literal(1),
      type: v.literal("string"),
      operator: v.picklist(["eq"]),
      value: vStr,
    }),
    v.strictObject({
      version: v.literal(1),
      type: v.literal("string-array"),
      operator: v.picklist(["contains-every"]),
      value: v.pipe(v.array(vStr), v.nonEmpty()),
    }),
  ]);
};

const getAiModelTool = (t: Translator) => {
  const vStr = getVString(t);
  return v.strictObject({
    version: v.literal(1),
    type: v.literal("ai-model"),
    prompt: vStr,
    dependencies: v.pipe(
      v.array(
        v.strictObject({
          dependsOnPropertyId: vStr,
          condition: v.nullable(getDependencyCondition(t)),
        }),
      ),
      v.nonEmpty(t("workspaces.properties.addInputProperty")),
    ),
  });
};

const manualInputTool = v.strictObject({
  version: v.literal(1),
  type: v.literal("manual-input"),
});

const getPropertyFormSchema = (t: Translator) => {
  const vStr = getVString(t);
  return v.variant("type", [
    v.strictObject({
      version: v.literal(1),
      type: v.literal("file"),
      tool: manualInputTool,
      name: vStr,
    }),
    v.strictObject({
      version: v.literal(1),
      type: v.literal("text"),
      tool: v.union([getAiModelTool(t), manualInputTool]),
      name: vStr,
    }),
    v.strictObject({
      version: v.literal(1),
      type: v.picklist(["single-select", "multi-select"]),
      tool: v.union([getAiModelTool(t), manualInputTool]),
      name: vStr,
      options: v.pipe(
        v.array(
          v.strictObject({
            color: v.custom<OptionColor>((data) => typeof data === "string"),
            value: v.string(),
          }),
        ),
        v.nonEmpty(t("common.required")),
      ),
      fallback: v.nullable(v.string()),
    }),
    v.strictObject({
      version: v.literal(1),
      type: v.literal("date"),
      tool: v.union([getAiModelTool(t), manualInputTool]),
      name: vStr,
    }),
    v.strictObject({
      version: v.literal(1),
      type: v.literal("int"),
      tool: v.union([getAiModelTool(t), manualInputTool]),
      name: vStr,
    }),
  ]);
};

type PropertyFormSchema = v.InferInput<
  ReturnType<typeof getPropertyFormSchema>
>;

const isSelectProperty = (
  values: PropertyFormSchema,
): values is Extract<
  PropertyFormSchema,
  { type: "single-select" | "multi-select" }
> => values.type === "single-select" || values.type === "multi-select";

const getDefaultValues = (property: WorkspaceProperty): PropertyFormSchema => {
  if (property.content.type === "file") {
    return {
      version: 1,
      type: "file",
      tool: { version: 1, type: "manual-input" },
      name: property.name,
    };
  }

  if (property.content.type === "text") {
    return {
      version: 1,
      type: "text",
      name: property.name,
      tool: property.tool,
    };
  }

  if (property.content.type === "date" || property.content.type === "int") {
    return {
      version: 1,
      type: property.content.type,
      name: property.name,
      tool: property.tool,
    };
  }

  return {
    version: 1,
    type: property.content.type,
    name: property.name,
    tool: property.tool,
    options: property.content.options,
    fallback: property.content.fallback,
  };
};

type PropertyPopoverProps = {
  property: WorkspaceProperty;
  header: TableHeader;
};

export const PropertyPopover = ({ property, header }: PropertyPopoverProps) => {
  const t = useTranslations();
  const { workspaceId, id, name, content } = property;
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const isWorkflowRunning = useIsWorkflowRunning();
  const updateProperty = useUpdateProperty();
  const startWorkflow = useStartWorkflow();
  const form = useForm({
    defaultValues: getDefaultValues(property),
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: getPropertyFormSchema(t),
    },
    onSubmit: ({ value }) => {
      if (isWorkflowRunning || updateProperty.isPending) {
        return;
      }

      const { name: newName, tool: newTool, ...newContent } = value;
      const isAIProperty = newTool.type === "ai-model";

      updateProperty.mutate(
        {
          workspaceId,
          propertyId: id,
          name: newName,
          content: newContent,
          tool: newTool,
        },
        {
          onSuccess: () => {
            if (!isAIProperty) {
              return;
            }

            const entityIdsOrder = getEntityIdsOrderFromRows(
              header.getContext().table.getRowModel().rows,
            );
            void startWorkflow(
              entityIdsOrder.length > 0 ? { entityIdsOrder } : undefined,
            ).then((result) => {
              if (result === undefined) {
                toastManager.add({
                  title: t("errors.actionFailed"),
                  type: "error",
                });
              }
            });
          },
          onError: () => {
            toastManager.add({
              title: t("errors.actionFailed"),
              type: "error",
            });
          },
        },
      );
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

  return (
    <Popover
      modal={true}
      // eslint-disable-next-line typescript/no-misused-promises
      onOpenChange={(open) => {
        void (async () => {
          if (open || !form.state.isDirty) {
            setIsOpen(open);
            return;
          }

          const toolType = form.state.values.tool.type;

          if (toolType === "ai-model") {
            const properties = await queryClient.ensureQueryData(
              propertiesOptions(workspaceId),
            );

            const dependencies = form.getFieldValue("tool.dependencies") ?? [];

            const result = validatePropertyInputs({
              currentPropertyId: id,
              currentInputs: dependencies.map(
                (dependency) => dependency.dependsOnPropertyId,
              ),
              properties,
            });

            if (Result.isError(result)) {
              form.setErrorMap({
                onSubmit: {
                  fields: {
                    "tool.prompt": t("workspaces.properties.referencesItself"),
                  },
                },
              });

              return;
            }
          }

          const errors = await form.validate("submit");

          if (Object.keys(errors).length > 0) {
            return;
          }

          // eslint-disable-next-line typescript/no-floating-promises
          form.handleSubmit();
          setIsOpen(open);
        })();
      }}
      open={isOpen}
    >
      <PropertyPopoverTrigger
        disabled={updateProperty.isPending}
        name={name}
        property={property}
      />
      <PopoverPopup
        align="start"
        className="min-w-80 overflow-clip *:data-[slot=popover-viewport]:p-0!"
      >
        <Form className="bg-muted/72" errors={formErrors}>
          <form.Field
            children={(field) => (
              <PropertyTextInput field={field} placeholder={name} />
            )}
            name="name"
          />
          <div className="bg-popover relative rounded-t-xl border border-b-0 [clip-path:inset(0_1px)] before:pointer-events-none before:absolute before:inset-0 before:rounded-t-[calc(var(--radius-xl)-1px)]">
            <PropertyPopoverType type={content.type} />
            <div className="flex flex-col gap-1 p-1">
              {content.type !== "file" && (
                <form.Field
                  children={(field) => <SelectTool field={field} />}
                  name="tool.type"
                />
              )}
              <form.Subscribe selector={(s) => s.values.tool.type}>
                {(toolType) =>
                  toolType === "ai-model" && (
                    <form.Field
                      children={(field) => (
                        <PropertyPromptInput
                          dependenciesField={
                            <form.Field
                              children={(f) => (
                                <Field.Root
                                  className={
                                    f.state.meta.errors.length > 0
                                      ? "block"
                                      : "hidden"
                                  }
                                  name={f.name}
                                >
                                  <FieldError />
                                </Field.Root>
                              )}
                              name="tool.dependencies"
                            />
                          }
                          field={field}
                          onMentionsChange={(mentions) => {
                            form.setFieldValue("tool.dependencies", (prev) =>
                              mentions.map((mention) => {
                                const prevCondition = (prev ?? []).find(
                                  (dependency) =>
                                    dependency.dependsOnPropertyId === mention,
                                )?.condition;

                                return {
                                  dependsOnPropertyId: mention,
                                  condition: prevCondition ?? null,
                                };
                              }),
                            );
                          }}
                          propertyId={id}
                          propertyName={name}
                          workspaceId={workspaceId}
                        />
                      )}
                      name="tool.prompt"
                    />
                  )
                }
              </form.Subscribe>
              {isSelectProperty(form.state.values) && (
                <div>
                  <form.Field
                    children={(field) => (
                      <form.Subscribe
                        selector={(s) =>
                          isSelectProperty(s.values) ? s.values.options : []
                        }
                      >
                        {(options) => (
                          <SelectOptions
                            fieldName={field.name}
                            options={options}
                            pushValue={field.pushValue}
                            removeValue={field.removeValue}
                            replaceValue={field.replaceValue}
                          />
                        )}
                      </form.Subscribe>
                    )}
                    mode="array"
                    name="options"
                  />
                  <form.Field
                    children={(field) => (
                      <form.Subscribe
                        selector={(s) =>
                          isSelectProperty(s.values) ? s.values.options : []
                        }
                      >
                        {(options) => (
                          <SelectFallback
                            onValueChange={field.handleChange}
                            options={options}
                            value={field.state.value}
                          />
                        )}
                      </form.Subscribe>
                    )}
                    name="fallback"
                  />
                </div>
              )}
            </div>
            <Separator />
            <SortProperty
              column={header.column}
              sortHint={toSortHint(property.content.type)}
            />
            <Separator />
            <div className="flex flex-col p-1">
              <form.Subscribe
                selector={(s) =>
                  s.values.tool.type === "ai-model"
                    ? (s.values.tool.dependencies ?? [])
                    : []
                }
              >
                {(dependencies) => (
                  <form.Field
                    children={(field) => (
                      <PropertyConditions
                        dependencies={dependencies}
                        replaceValue={field.replaceValue}
                        workspaceId={workspaceId}
                      />
                    )}
                    mode="array"
                    name="tool.dependencies"
                  />
                )}
              </form.Subscribe>
              <PinProperty column={header.column} />
              <Button
                className="justify-start gap-1.5"
                onClick={() => {
                  header.column.toggleVisibility(false);
                  setIsOpen(false);
                }}
                size="sm"
                variant="ghost"
              >
                <EyeOffIcon />
                {t("workspaces.kanban.hideColumn")}
              </Button>
              <DeleteProperty property={property} workspaceId={workspaceId} />
            </div>
          </div>
        </Form>
      </PopoverPopup>
    </Popover>
  );
};
