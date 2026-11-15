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
import {
  organizationKeys,
  organizationOptions,
} from "@/lib/organization/queries";
import { getOrganizationSchema } from "@/lib/organization/utils";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";
import { resourceMutation } from "@/lib/workspace-realtime";

const getNameOnlySchema = () => v.pick(getOrganizationSchema(), ["name"]);

export const OrganizationProfileCard = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data } = useSuspenseQuery(organizationOptions(activeOrganizationId));
  const [pendingName, setPendingName] = useState<string | null>(null);
  const canChange = usePermissions({ organization: ["update"] });

  const logoMutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "updateOrganization",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (logo: string | null) => {
        const result = await authClient.organization.update({
          data: { logo },
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
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const uploadLogo = async (file: File) => {
    const logo = await toOrganizationLogo(file);
    if (logo) {
      logoMutation.mutate(logo);
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
    const result = await authClient.organization.update({
      data: { name: pendingName },
    });

    if (result.error) {
      analytics.captureError(toAuthClientError(result.error), {
        fingerprintKey: "OrganizationProfileCard.performRename:failure",
        scope: {
          type: "handler",
          handlerId: "OrganizationProfileCard.performRename:failure",
        },
      });
      notifyUserError(
        toAuthClientError(result.error),
        t("errors.actionFailed"),
      );
      // Keep the confirm dialog open so the rename can be retried.
      return "keep-open" satisfies DestructiveConfirmOutcome;
    }

    await queryClient.invalidateQueries({ queryKey: organizationKeys.root });
    form.reset({ name: pendingName });
    stellaToast.add({
      title: t("success.organizationUpdated"),
      type: "success",
    });
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
                    loading={logoMutation.isPending}
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
                      disabled={logoMutation.isPending}
                      onClick={() => {
                        logoMutation.mutate(null);
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
