import { useState } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import type { DestructiveConfirmOutcome } from "@stll/ui/destructive-confirm-dialog";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { openFilePicker } from "@stll/ui/file-picker";
import { Form } from "@stll/ui/form";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";

import { UserIdentityAvatar } from "@/components/user-avatar";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { readQueryResult } from "@/lib/errors/query-result";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import {
  ORGANIZATION_LOGO_ACCEPT,
  toOrganizationLogo,
} from "@/lib/organization/logo";
import { organizationOptions } from "@/lib/organization/queries";
import { getOrganizationSchema } from "@/lib/organization/utils";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";
import { resourceMutation } from "@/lib/workspace-realtime";

const getNameOnlySchema = () => v.pick(getOrganizationSchema(), ["name"]);

/** A write names its organization so a switch mid-upload cannot redirect it. */
type OrganizationProfileUpdate = {
  organizationId: string;
  fields: { name: string } | { logo: string | null };
};

export const OrganizationProfileCard = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data } = useSuspenseQuery(organizationOptions(activeOrganizationId));
  const [pendingName, setPendingName] = useState<string | null>(null);
  const canChange = usePermissions({ organization: ["update"] });

  // Renames and logo changes are one organization write, so both refresh
  // every organization reader through the same resource contract.
  const updateMutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "updateOrganization",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async ({
        organizationId,
        fields,
      }: OrganizationProfileUpdate) => {
        const result = await authClient.organization.update({
          organizationId,
          data: fields,
        });
        readQueryResult(
          result.error
            ? Result.err(toAuthClientError(result.error))
            : Result.ok(),
        );
      },
    }),
    onSuccess: () => {
      stellaToast.add({
        title: t("success.organizationUpdated"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "OrganizationProfileCard.update:failure",
        scope: {
          type: "handler",
          handlerId: "OrganizationProfileCard.update:failure",
        },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const uploadLogo = async (file: File) => {
    // Pin the organization the file was picked for before the resize awaits.
    const organizationId = data.id;
    const logo = await toOrganizationLogo(file);
    if (logo) {
      updateMutation.mutate({ organizationId, fields: { logo } });
    } else {
      notifyUserProblem(t("settings.organization.logoInvalid"));
    }
  };

  const form = useForm(
    schemaFormOptions({
      schema: getNameOnlySchema(),
      defaultValues: {
        name: data.name,
      },
      submitValues: "schema-output",
      onSubmit: ({ value }) => {
        // Defer the mutation to the type-to-confirm dialog so renames
        // can't fire from a stray click.
        setPendingName(value.name);
      },
    }),
  );

  const formErrors = useSelector(form.store, (s) => toFormErrors(s.fieldMeta));

  const performRename = async () => {
    if (!pendingName) {
      return undefined;
    }
    const renamed = await Result.tryPromise(
      async () =>
        await updateMutation.mutateAsync({
          organizationId: data.id,
          fields: { name: pendingName },
        }),
    );
    if (Result.isError(renamed)) {
      // The mutation already reported the failure; keep the confirm dialog
      // open so the rename can be retried.
      return "keep-open" satisfies DestructiveConfirmOutcome;
    }

    form.reset({ name: pendingName });
    setPendingName(null);
    return undefined;
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
              detached(form.handleSubmit(), "profile-card.submit");
            }}
          >
            <div className="flex items-center gap-3">
              <UserIdentityAvatar
                className="size-12 text-sm"
                image={data.logo}
                name={data.name}
              />
              {canChange ? (
                <>
                  <Button
                    loading={updateMutation.isPending}
                    onClick={() => {
                      openFilePicker({
                        accept: ORGANIZATION_LOGO_ACCEPT,
                        onPick: ([file]) => {
                          detached(
                            uploadLogo(file),
                            "profile-card.upload-logo",
                          );
                        },
                      });
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {t("settings.organization.uploadLogo")}
                  </Button>
                  {data.logo ? (
                    <Button
                      disabled={updateMutation.isPending}
                      onClick={() => {
                        updateMutation.mutate({
                          organizationId: data.id,
                          fields: { logo: null },
                        });
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t("common.remove")}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
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
        confirmLabel={t("common.rename")}
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
