import { useState } from "react";

import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
import { Field, FieldError, FieldLabel } from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import { toastManager } from "@stll/ui/components/toast";
import { useForm, useStore } from "@tanstack/react-form";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { toFormErrors } from "@/lib/schema";
import {
  organizationKeys,
  organizationOptions,
} from "@/routes/_protected.organization/-queries";
import { getOrganizationSchema } from "@/routes/_protected.organization/-utils";

const getNameOnlySchema = () => v.pick(getOrganizationSchema(), ["name"]);

export const OrganizationProfileCard = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(organizationOptions);
  const [pendingName, setPendingName] = useState<string | null>(null);

  const form = useForm({
    defaultValues: {
      name: data.name,
    },
    validators: { onDynamic: getNameOnlySchema() },
    onSubmit: ({ value }) => {
      const parseResult = v.safeParse(getNameOnlySchema(), value);
      if (!parseResult.success) {
        return;
      }
      // Defer the mutation to the type-to-confirm dialog so renames
      // can't fire from a stray click.
      setPendingName(parseResult.output.name);
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

  const performRename = async () => {
    if (!pendingName) {
      return;
    }
    const result = await authClient.organization.update({
      data: { name: pendingName },
    });

    if (result.error) {
      analytics.captureError(toAuthClientError(result.error));
      toastManager.add({
        title: result.error.message ?? t("errors.actionFailed"),
        type: "error",
      });
      throw toAuthClientError(result.error);
    }

    await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
    form.reset({ name: pendingName });
    toastManager.add({
      title: t("success.organizationUpdated"),
      type: "success",
    });
    setPendingName(null);
  };

  return (
    <>
      <Frame>
        <FramePanel>
          <Form
            className="gap-4 p-1"
            errors={formErrors}
            onSubmit={(e) => {
              e.preventDefault();
              // eslint-disable-next-line typescript/no-floating-promises
              form.handleSubmit();
            }}
          >
            <form.Field name="name">
              {(field) => (
                <Field name={field.name}>
                  <FieldLabel>{t("common.organizationName")}</FieldLabel>
                  <Input
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t("auth.organizationNamePlaceholder")}
                    required
                    value={field.state.value}
                  />
                  <FieldError />
                </Field>
              )}
            </form.Field>
            <form.Subscribe
              selector={(s) => ({
                isSubmitting: s.isSubmitting,
                isDirty: s.isDirty,
                canSubmit: s.canSubmit,
              })}
            >
              {({ isSubmitting, isDirty, canSubmit }) => (
                <Button
                  className="self-start"
                  disabled={!isDirty || !canSubmit}
                  loading={isSubmitting}
                  type="submit"
                >
                  {t("common.saveChanges")}
                </Button>
              )}
            </form.Subscribe>
          </Form>
        </FramePanel>
      </Frame>
      <DestructiveConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmation={pendingName ?? ""}
        confirmLabel={t("settings.organization.renameAction")}
        description={t("settings.organization.renameDescription")}
        inputLabel={t("settings.organization.renameTypeToConfirm", {
          name: pendingName ?? "",
        })}
        onConfirm={performRename}
        onOpenChange={(open) => {
          if (!open) {
            setPendingName(null);
          }
        }}
        open={pendingName !== null}
        title={t("settings.organization.renameTitle")}
      />
    </>
  );
};
