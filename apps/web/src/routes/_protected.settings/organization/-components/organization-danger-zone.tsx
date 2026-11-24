import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import type { DestructiveConfirmOutcome } from "@stll/ui/destructive-confirm-dialog";

import { SettledQueryViewFeedback } from "@/components/query-view-feedback";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import { organizationAuditExportLatestOptions } from "@/lib/organization/audit-export-queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { resourceMutation } from "@/lib/workspace-realtime";

import { OrganizationAuditArchive } from "./organization-audit-archive";
import { OrganizationAuditArchivePending } from "./organization-audit-archive.pending";
import {
  OrganizationDangerZoneRow,
  OrganizationDangerZoneSection,
} from "./organization-danger-zone.pending";

type OrganizationDangerZoneProps = {
  organizationId: string;
  organizationName: string;
  isOwner: boolean;
  onSuccess: () => Promise<void>;
};

const SUBSCRIPTION_RENEWS_CODE = "organization_subscription_renews";
const ONLY_OWNER_LEAVE_CODE =
  "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER";

export const OrganizationDangerZone = ({
  organizationId,
  organizationName,
  isOwner,
  onSuccess,
}: OrganizationDangerZoneProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { id: userId } = useAuthenticatedUser();
  const auditExportOptions = organizationAuditExportLatestOptions(
    organizationId,
    userId,
  );
  // Deleting the organization deletes its audit log; the confirmation
  // recommends a current archive of it but does not require one.
  const auditExportView = queryView(
    useQuery({ ...auditExportOptions, enabled: isOwner }),
    { isEmpty: (data) => data === null },
  );
  useQueryViewError(auditExportView, "OrganizationDangerZone:auditArchive");
  const auditArchive =
    auditExportView.type === "items" ? auditExportView.items : null;
  // A failed refresh leaves the last archive on screen, but its coverage is
  // no longer confirmed, so the confirmation still recommends taking one.
  const auditArchiveCurrent =
    auditExportView.type === "items" &&
    auditExportView.refetchError === undefined &&
    auditArchive?.status === "ready" &&
    auditArchive.coversCurrentTrail &&
    auditArchive.downloaded;
  const requestAuditArchive = useMutation({
    onMutate: async () => {
      await queryClient.cancelQueries({
        queryKey: auditExportOptions.queryKey,
      });
    },
    // Organization deletion is a signed-in owner's decision in the web app,
    // so the archive request has no automation capability.
    mutationFn: async () =>
      await invokeAppOnlyWrite("organizations.audit-export.create", async () =>
        unwrapApiResponse(await api.organizations["audit-export"].post()),
      ),
    onSuccess: async (status) => {
      queryClient.setQueryData(auditExportOptions.queryKey, status);
      await queryClient.invalidateQueries({
        queryKey: auditExportOptions.queryKey,
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "OrganizationDangerZone.auditArchive:failure",
        scope: {
          type: "handler",
          handlerId: "OrganizationDangerZone.auditArchive:failure",
        },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [outcome, setOutcome] = useState<
    | { status: "active" }
    | { status: "refused"; code: string | undefined }
    | { status: "completed"; action: "leave" | "delete" }
  >({ status: "active" });
  const mutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "deleteOrganization",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (action: "leave" | "delete") => {
        setOutcome({ status: "active" });
        const result =
          action === "delete"
            ? await authClient.organization.delete({ organizationId })
            : await authClient.organization.leave({ organizationId });
        if (result.error) {
          // A refusal is an outcome the section shows, not a thrown failure.
          analytics.captureError(toAuthClientError(result.error), {
            fingerprintKey: "OrganizationDangerZone.refused:failure",
            scope: {
              type: "handler",
              handlerId: "OrganizationDangerZone.refused:failure",
            },
          });
          setOutcome({ status: "refused", code: result.error.code });
          return "refused" as const;
        }
        setOutcome({ status: "completed", action });
        setDeleteOpen(false);
        await onSuccess();
        return "completed" as const;
      },
    }),
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "OrganizationDangerZone.mutation:failure",
        scope: {
          type: "handler",
          handlerId: "OrganizationDangerZone.mutation:failure",
        },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
  // The dialog awaits this and keeps itself open on a refusal it shows.
  const confirmDelete = async (): Promise<
    DestructiveConfirmOutcome | undefined
  > => {
    const result = await mutation.mutateAsync("delete");
    return result === "refused" ? "keep-open" : undefined;
  };
  const organizationMutationReason =
    mutation.variables === "leave"
      ? t("admin.leavingOrganization")
      : t("common.deleting");
  const refusalCode = outcome.status === "refused" ? outcome.code : undefined;
  const refusalMessage = (() => {
    if (refusalCode === undefined) {
      return t("errors.actionFailed");
    }
    switch (refusalCode) {
      case SUBSCRIPTION_RENEWS_CODE:
        return t("admin.deleteRefusedSubscription");
      case ONLY_OWNER_LEAVE_CODE:
        return t("admin.leaveRefusedOnlyOwner");
      default:
        return t("errors.actionFailed");
    }
  })();

  return (
    <>
      <OrganizationDangerZoneSection>
        <OrganizationDangerZoneRow
          action={
            <Button
              disabled={mutation.isPending || outcome.status === "completed"}
              disabledReason={
                mutation.isPending
                  ? organizationMutationReason
                  : t("admin.organizationChangeCompleted")
              }
              loading={mutation.isPending && mutation.variables === "leave"}
              onClick={() => mutation.mutate("leave")}
              variant="outline"
            >
              {t("admin.leaveOrganization")}
            </Button>
          }
          description="admin.leaveDescription"
        />
        {isOwner && <SettledQueryViewFeedback view={auditExportView} />}
        {isOwner && auditExportView.type === "pending" && (
          <OrganizationAuditArchivePending />
        )}
        {isOwner &&
          (auditExportView.type === "empty" ||
            auditExportView.type === "items") && (
            <OrganizationAuditArchive
              status={auditArchive}
              requestPending={requestAuditArchive.isPending}
              onRequest={() => requestAuditArchive.mutate()}
            />
          )}
        {isOwner && (
          <OrganizationDangerZoneRow
            action={
              <Button
                disabled={mutation.isPending || outcome.status === "completed"}
                disabledReason={
                  mutation.isPending
                    ? organizationMutationReason
                    : t("admin.organizationChangeCompleted")
                }
                onClick={() => setDeleteOpen(true)}
                variant="destructive"
              >
                {t("admin.deleteOrganization")}
              </Button>
            }
            description="admin.deleteDescription"
          />
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
            <p>{refusalMessage}</p>
            {outcome.code === SUBSCRIPTION_RENEWS_CODE && (
              <a className="underline" href="/settings/organization/usage">
                {t("admin.planAndUsage")}
              </a>
            )}
          </div>
        )}
      </OrganizationDangerZoneSection>
      {isOwner && (
        <DestructiveConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmation={organizationName}
          confirmLabel={t("admin.deleteOrganization")}
          description={
            <>
              {t("admin.deleteDescription")}
              {!auditArchiveCurrent && (
                <span className="mt-2 block">
                  {t("admin.deleteWithoutAuditArchive")}
                </span>
              )}
              {outcome.status === "refused" && (
                <span className="mt-2 block" role="alert">
                  {refusalMessage}
                  {outcome.code === SUBSCRIPTION_RENEWS_CODE && (
                    <a
                      className="ms-2 underline"
                      href="/settings/organization/usage"
                    >
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
          onConfirm={confirmDelete}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
          title={t("admin.deleteOrganization")}
        />
      )}
    </>
  );
};
