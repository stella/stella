import { useState } from "react";
import { usePostHog } from "@posthog/react";
import {
  revalidateLogic,
  useForm,
  type AnyFieldApi,
} from "@tanstack/react-form";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stella/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stella/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@stella/ui/components/field";
import { Form } from "@stella/ui/components/form";
import { Input } from "@stella/ui/components/input";
import { toastManager } from "@stella/ui/components/toast";

import { captureError } from "@/lib/posthog/utils";
import { toFormErrors } from "@/lib/schema";
import type {
  EntityKind,
  WorkspaceField,
  WorkspacePropertyOption,
} from "@/lib/types";
import { FieldValueSelect } from "@/routes/_protected.workspaces/$workspaceId/-components/field-value-select";
import { useWorkflowActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-workflow-actor";
import { useUpsertField } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

export type EditableFieldContent = Extract<
  WorkspaceField["content"],
  { type: "text" | "single-select" | "multi-select" | "date" | "int" }
>;

const fieldFormSchema = v.variant("type", [
  v.object({
    type: v.literal("text"),
    value: v.string(),
  }),
  v.object({
    type: v.literal("single-select"),
    value: v.nullable(v.string()),
  }),
  v.object({
    type: v.literal("multi-select"),
    value: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty()))),
  }),
  v.object({
    type: v.literal("date"),
    value: v.nullable(v.pipe(v.string(), v.isoDate("Must be YYYY-MM-DD"))),
  }),
  v.object({
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

  throw new Error("Invalid field content type");
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
  const posthog = usePostHog();
  const [isOpen, setIsOpen] = useState(false);
  const isWorkflowRunning = useIsWorkflowRunning();
  const upsertField = useUpsertField();
  const workflowActor = useWorkflowActor(workspaceId);
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

            workflowActor.connection
              ?.startWorkflow({
                workspaceId,
                entityIds: [entityId],
                entityIdsOrder: [],
              })
              .catch((error) => captureError(posthog, error));
          },
          onSettled: () => {
            setIsOpen(false);
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
                          // SAFETY: guarded by fieldContent.type check
                          value={
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
                          // SAFETY: guarded by fieldContent.type check
                          value={
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
                        <Input
                          onBlur={field.handleBlur}
                          onChange={(e) =>
                            field.handleChange(e.target.value || null)
                          }
                          placeholder="YYYY-MM-DD"
                          type="date"
                          value={
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

type TextFormFieldProps = {
  field: AnyFieldApi;
};

const TextFormField = ({ field }: TextFormFieldProps) => {
  const t = useTranslations();

  return (
    <Field name={field.name}>
      <FieldLabel>{t("workspaces.fields.fieldValueLabel")}</FieldLabel>
      <Input
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        placeholder={t("workspaces.fields.fieldValuePlaceholder")}
        value={field.state.value}
      />
      <FieldError />
    </Field>
  );
};
