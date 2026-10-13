import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import { Frame, FramePanel } from "@stll/ui/frame";

import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";

type OrganizationDangerZoneProps = {
  organizationId: string;
  organizationName: string;
  isOwner: boolean;
  onSuccess: () => Promise<void>;
};

const SUBSCRIPTION_RENEWS_CODE = "organization_subscription_renews";

export const OrganizationDangerZone = ({
  organizationId,
  organizationName,
  isOwner,
  onSuccess,
}: OrganizationDangerZoneProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [outcome, setOutcome] = useState<
    | { status: "active" }
    | { status: "refused"; message: string; code: string | undefined }
    | { status: "completed"; action: "leave" | "delete" }
  >({ status: "active" });
  const mutation = useMutation({
    mutationFn: async (action: "leave" | "delete") => {
      setOutcome({ status: "active" });
      const result =
        action === "delete"
          ? await authClient.organization.delete({ organizationId })
          : await authClient.organization.leave({ organizationId });
      if (result.error) {
        const error = toAuthClientError(result.error);
        setOutcome({
          status: "refused",
          message:
            result.error.status < 500
              ? (result.error.message ?? t("errors.actionFailed"))
              : t("errors.actionFailed"),
          code: result.error.code,
        });
        throw error;
      }
      setOutcome({ status: "completed", action });
      setDeleteOpen(false);
      await onSuccess();
    },
    onError: (error) => {
      analytics.captureError(error);
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  return (
    <>
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">
          {t("settings.account.dangerZone")}
        </h2>
        <Frame>
          <FramePanel>
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted-foreground text-sm">
                  {t("admin.leaveDescription")}
                </p>
                <Button
                  disabled={
                    mutation.isPending || outcome.status === "completed"
                  }
                  loading={mutation.isPending && mutation.variables === "leave"}
                  onClick={() => mutation.mutate("leave")}
                  variant="outline"
                >
                  {t("admin.leaveOrganization")}
                </Button>
              </div>
              {isOwner && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-muted-foreground text-sm">
                    {t("admin.deleteDescription")}
                  </p>
                  <Button
                    disabled={
                      mutation.isPending || outcome.status === "completed"
                    }
                    onClick={() => setDeleteOpen(true)}
                    variant="destructive"
                  >
                    {t("admin.deleteOrganization")}
                  </Button>
                </div>
              )}
              {outcome.status === "completed" && (
                <p role="status">
                  {outcome.action === "leave"
                    ? t("admin.organizationLeft")
                    : t("admin.organizationDeleted")}
                </p>
              )}
              {outcome.status === "refused" && (
                <div role="alert" className="flex flex-col gap-2 text-sm">
                  <p>{outcome.message}</p>
                  {outcome.code === SUBSCRIPTION_RENEWS_CODE && (
                    <a className="underline" href="/admin/usage">
                      {t("admin.planAndUsage")}
                    </a>
                  )}
                </div>
              )}
            </div>
          </FramePanel>
        </Frame>
      </section>
      {isOwner && (
        <DestructiveConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmation={organizationName}
          confirmLabel={t("admin.deleteOrganization")}
          description={
            <>
              {t("admin.deleteDescription")}
              {outcome.status === "refused" && (
                <span className="mt-2 block" role="alert">
                  {outcome.message}
                  {outcome.code === SUBSCRIPTION_RENEWS_CODE && (
                    <a className="ms-2 underline" href="/admin/usage">
                      {t("admin.planAndUsage")}
                    </a>
                  )}
                </span>
              )}
            </>
          }
          inputLabel={t("admin.deleteTypeToConfirm", {
            name: organizationName,
          })}
          loading={mutation.isPending}
          onConfirm={async () => {
            await mutation.mutateAsync("delete");
          }}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
          title={t("admin.deleteOrganization")}
        />
      )}
    </>
  );
};
