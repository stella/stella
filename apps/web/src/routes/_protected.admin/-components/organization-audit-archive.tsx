import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import { RecoverableErrorStatus } from "@/components/recoverable-error-status";
import { useFormatter } from "@/i18n/formatting-context";
import { apiUrl } from "@/lib/api-url";
import type { OrganizationAuditExportStatus } from "@/lib/organization/audit-export-queries";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

type OrganizationAuditArchiveProps = {
  status: OrganizationAuditExportStatus | null;
  requestPending: boolean;
  onRequest: () => void;
};

/**
 * The owner's archive of the organization's audit log, which deletion
 * requires: request it, follow its preparation, and download it.
 */
export const OrganizationAuditArchive = ({
  status,
  requestPending,
  onRequest,
}: OrganizationAuditArchiveProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const requestButton = (label: string) => (
    <Button
      disabled={requestPending}
      loading={requestPending}
      onClick={onRequest}
      size="sm"
      variant="outline"
    >
      {label}
    </Button>
  );

  const state = (() => {
    if (status === null) {
      return requestButton(t("admin.auditArchiveRequest"));
    }
    switch (status.status) {
      case "requested":
      case "processing":
        return (
          <div
            role="status"
            className="text-muted-foreground flex items-center gap-2 text-sm"
          >
            <Loader size="sm" variant="decorative" />
            {t("admin.auditArchiveWorking")}
          </div>
        );
      case "ready":
        return (
          <div className="flex flex-col items-start gap-3">
            <div className="space-y-1">
              <p role="status" className="text-sm">
                {status.coversCurrentTrail
                  ? t("admin.auditArchiveReady")
                  : t("admin.auditArchiveOutdated")}
              </p>
              <p className="text-muted-foreground text-sm">
                {t("settings.account.personalDataExportExpiresAt", {
                  expiresAt: format.dateTime(
                    new Date(
                      Temporal.Instant.from(status.expiresAt).epochMilliseconds,
                    ),
                    MEDIUM_DATE_SHORT_TIME_FORMAT,
                  ),
                })}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                render={
                  <a
                    download
                    href={sanitizeHref(
                      apiUrl(
                        `/me/data-exports/${encodeURIComponent(status.id)}/download`,
                      ),
                    )}
                  />
                }
                size="sm"
                variant="outline"
              >
                <DownloadIcon className="size-3.5" />
                {t("common.download")}
              </Button>
              {!status.coversCurrentTrail &&
                requestButton(t("admin.auditArchiveRequestNew"))}
            </div>
          </div>
        );
      case "failed":
        return (
          <RecoverableErrorStatus
            className="flex flex-col items-start gap-3"
            messageClassName="text-destructive text-sm"
            message={t("admin.auditArchiveFailed")}
            actions={requestButton(t("admin.auditArchiveRequestNew"))}
          />
        );
      case "expired":
        return (
          <div className="flex flex-col items-start gap-3">
            <p className="text-muted-foreground text-sm">
              {t("settings.account.personalDataExportExpired")}
            </p>
            {requestButton(t("admin.auditArchiveRequestNew"))}
          </div>
        );
      default: {
        status satisfies never;
        return panic("Unhandled audit log archive status");
      }
    }
  })();

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {t("admin.auditArchiveDescription")}
      </p>
      {state}
    </div>
  );
};
