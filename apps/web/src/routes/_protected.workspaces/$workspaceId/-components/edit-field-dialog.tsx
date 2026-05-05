import { useState } from "react";

import { Button } from "@stll/ui/components/button";
import { DatePickerPopover } from "@stll/ui/components/date-picker-popover";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";
import { revalidateLogic, useForm } from "@tanstack/react-form";
import type { AnyFieldApi } from "@tanstack/react-form";
import { panic } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { toFormErrors } from "@/lib/schema";
import type {
  EntityKind,
  WorkspaceField,
  WorkspacePropertyOption,
} from "@/lib/types";
import { FieldValueSelect } from "@/routes/_protected.workspaces/$workspaceId/-components/field-value-select";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import { useUpsertField } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

export type EditableFieldContent = Extract<
  WorkspaceField["content"],
  { type: "text" | "single-select" | "multi-select" | "date" | "int" }
>;

const fieldFormSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("text"),
    value: v.string(),
  }),
  v.strictObject({
    type: v.literal("single-select"),
    value: v.nullable(v.string()),
  }),
  v.strictObject({
    type: v.literal("multi-select"),
    value: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty()))),
  }),
  v.strictObject({
    type: v.literal("date"),
    value: v.nullable(v.pipe(v.string(), v.isoDate("Must be YYYY-MM-DD"))),
  }),
  v.strictObject({
    type: v.literal("int"),
    value: v.pipe(v.number(), v.integer()),
    currency: v.nullable(
      v.pipe(v.string(), v.length(3, "Must be 3-letter code")),
    ),
  }),
]);

type FieldFormSchema = v.InferInput<typeof fieldFormSchema>;

type FieldFormValue<T extends FieldFormSchema["type"]> = Extract<
  FieldFormSchema,
  { type: T }
>["value"];

const getDefaultValues = (
  fieldContent: EditableFieldContent,
): FieldFormSchema => {
  if (fieldContent.type === "text") {
    return {
      type: fieldContent.type,
      value: fieldContent.value,
    };
  }

  if (fieldContent.type === "single-select") {
    return {
      type: fieldContent.type,
      value: fieldContent.value,
    };
  }

  if (fieldContent.type === "multi-select") {
    return {
      type: "multi-select",
      value: fieldContent.value,
    };
  }

  if (fieldContent.type === "date") {
    return {
      type: "date",
      value: fieldContent.value ?? "",
    };
  }

  if (fieldContent.type === "int") {
    return {
      type: "int",
      value: fieldContent.value,
      currency: fieldContent.currency,
    };
  }

  return panic("Invalid field content type");
};

type EditFieldDialogProps = {
  workspaceId: string;
  propertyId: string;
  entityId: string;
  entityKind: EntityKind;
  options: WorkspacePropertyOption[];
  fieldContent: EditableFieldContent;
  className: string;
};

export const EditFieldDialog = ({
  workspaceId,
  propertyId,
  entityId,
  entityKind,
  options,
  fieldContent,
  className,
}: EditFieldDialogProps) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
  const isWorkflowRunning = useIsWorkflowRunning(workspaceId);
  const upsertField = useUpsertField();
  const startWorkflow = useStartWorkflow(workspaceId);
  const form = useForm({
    defaultValues: getDefaultValues(fieldContent),
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: fieldFormSchema,
    },
    onSubmit: ({ value }) => {
      upsertField.mutate(
        {
          workspaceId,
          propertyId,
          entityId,
          content: { version: 1, ...value },
        },
        {
          onSuccess: () => {
            // Auto-run workflow for this entity so dependent
            // AI columns get processed after manual input.
            // Folders can't have AI-derived metadata.
            if (entityKind === "folder") {
              return;
            }

            void startWorkflow({
              entityIds: [entityId],
            });
          },
          onSettled: () => {
            setIsOpen(false);
          },
          onError: () => {
            stellaToast.add({
              title: t("errors.actionFailed"),
              type: "error",
            });
          },
        },
      );
    },
  });

  return (
    <Dialog
      onOpenChange={setIsOpen}
      onOpenChangeComplete={(open) => {
        if (!open && upsertField.isSuccess) {
          form.reset();
        }
      }}
      open={isOpen}
    >
      <DialogTrigger className={className} render={<Button size="xs" />}>
        {t("common.edit")}
      </DialogTrigger>
      <DialogPopup className="sm:max-w-sm">
        <form.Subscribe selector={(s) => toFormErrors(s.fieldMeta)}>
          {(errors) => (
            <Form
              errors={errors}
              onSubmit={(e) => {
                e.preventDefault();
                // eslint-disable-next-line typescript/no-floating-promises
                form.handleSubmit();
              }}
            >
              <DialogHeader>
                <DialogTitle>
                  {t("workspaces.fields.editFieldValue")}
                </DialogTitle>
              </DialogHeader>
              <DialogPanel className="grid gap-4">
                {fieldContent.type === "text" && (
                  <form.Field
                    children={(field) => <TextFormField field={field} />}
                    name="value"
                  />
                )}
                {fieldContent.type === "single-select" && (
                  <form.Field
                    children={(field) => (
                      <Field>
                        <FieldValueSelect
                          onChange={(value) => field.handleChange(value)}
                          options={options}
                          type="single-select"
                          value={
                            // SAFETY: guarded by fieldContent.type check
                            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
                            field.state.value as FieldFormValue<"single-select">
                          }
                        />
                        <FieldError />
                      </Field>
                    )}
                    name="value"
                  />
                )}
                {fieldContent.type === "multi-select" && (
                  <form.Field
                    children={(field) => (
                      <Field>
                        <FieldValueSelect
                          onChange={field.handleChange}
                          options={options}
                          type="multi-select"
                          value={
                            // SAFETY: guarded by fieldContent.type check
                            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
                            field.state.value as FieldFormValue<"multi-select">
                          }
                        />
                        <FieldError />
                      </Field>
                    )}
                    mode="array"
                    name="value"
                  />
                )}
                {fieldContent.type === "date" && (
                  <form.Field
                    children={(field) => (
                      <Field name={field.name}>
                        <FieldLabel>{t("common.date")}</FieldLabel>
                        <DatePickerPopover
                          onChange={(val) => field.handleChange(val)}
                          value={
                            // SAFETY: guarded by fieldContent.type check
                            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
                            (field.state.value as FieldFormValue<"date">) ?? ""
                          }
                        />
                        <FieldError />
                      </Field>
                    )}
                    name="value"
                  />
                )}
                {fieldContent.type === "int" && (
                  <>
                    <form.Field
                      children={(field) => (
                        <Field name={field.name}>
                          <FieldLabel>
                            {t("workspaces.fields.numberLabel")}
                          </FieldLabel>
                          <Input
                            onBlur={field.handleBlur}
                            onChange={(e) =>
                              field.handleChange(
                                Number.isNaN(e.target.valueAsNumber)
                                  ? 0
                                  : e.target.valueAsNumber,
                              )
                            }
                            placeholder={t(
                              "workspaces.fields.numberPlaceholder",
                            )}
                            type="number"
                            // SAFETY: guarded by fieldContent.type check
                            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
                            value={field.state.value as FieldFormValue<"int">}
                          />
                          <FieldError />
                        </Field>
                      )}
                      name="value"
                    />
                    <form.Field
                      children={(field) => (
                        <Field name={field.name}>
                          <FieldLabel>
                            {t("workspaces.fields.currencyLabel")}
                          </FieldLabel>
                          <Input
                            maxLength={3}
                            onBlur={field.handleBlur}
                            onChange={(e) =>
                              field.handleChange(
                                e.target.value
                                  ? e.target.value.toUpperCase()
                                  : null,
                              )
                            }
                            placeholder={t(
                              "workspaces.fields.currencyPlaceholder",
                            )}
                            value={field.state.value ?? ""}
                          />
                          <FieldError />
                        </Field>
                      )}
                      name="currency"
                    />
                  </>
                )}
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>
                  {t("common.cancel")}
                </DialogClose>
                <Button
                  disabled={isWorkflowRunning}
                  loading={upsertField.isPending}
                  type="submit"
                >
                  {t("common.save")}
                </Button>
              </DialogFooter>
            </Form>
          )}
        </form.Subscribe>
      </DialogPopup>
    </Dialog>
  );
};

// TODO: FIXME — replace AnyFieldApi with a properly typed FieldApi
type TextFormFieldProps = {
  field: AnyFieldApi;
};

const TextFormField = ({ field }: TextFormFieldProps) => {
  const t = useTranslations();

  return (
    // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
    <Field name={field.name}>
      <FieldLabel>{t("workspaces.fields.fieldValueLabel")}</FieldLabel>
      <Input
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        placeholder={t("workspaces.fields.fieldValuePlaceholder")}
        // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
        value={field.state.value}
      />
      <FieldError />
    </Field>
  );
};
