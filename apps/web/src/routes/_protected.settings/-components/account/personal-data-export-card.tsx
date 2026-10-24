import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { DownloadIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { accountDataExportLatestOptions } from "@/lib/account/account-data-export-queries";
import type { AccountDataExportStatus as AccountDataExportStatusData } from "@/lib/account/account-data-export-queries";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

export const PersonalDataExportCard = () => {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { id: userId } = useAuthenticatedUser();
  const latestOptions = accountDataExportLatestOptions(userId);
  const latestQuery = useQuery(latestOptions);
  const latestView = useQueryView(latestQuery, {
    isEmpty: (data) => data === null,
  });
  useQueryViewError(latestView);

  const requestExport = useMutation({
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: latestOptions.queryKey });
    },
    mutationFn: async () =>
      await invokeCapability("account-exports.create", async (request) =>
        unwrapEden(await api.me["data-exports"].post(undefined, request)),
      ),
    onSuccess: async (status) => {
      queryClient.setQueryData(latestOptions.queryKey, status);
      await queryClient.invalidateQueries({ queryKey: latestOptions.queryKey });
    },
    onError: (error) => {
      analytics.captureError(error);
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const requestButton = (label: string) => (
    <Button
      disabled={requestExport.isPending}
      loading={requestExport.isPending}
      onClick={() => requestExport.mutate()}
      size="sm"
      variant="outline"
    >
      {label}
    </Button>
  );

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>{t("settings.account.personalDataExportTitle")}</FrameTitle>
        <FrameDescription>
          {t("settings.account.personalDataExportDescription")}
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <div className="flex flex-col items-start gap-3 p-4">
          {latestView.type === "pending" && (
            <QueryViewFeedback view={latestView} />
          )}
          {latestView.type === "error" && (
            <QueryViewFeedback view={latestView} />
          )}
          {latestView.type === "empty" &&
            requestButton(t("settings.account.personalDataExportRequest"))}
          {latestView.type === "items" && latestView.items !== null && (
            <>
              <QueryViewFeedback view={latestView} />
              <PersonalDataExportStatus
                onRequest={() => requestExport.mutate()}
                requestPending={requestExport.isPending}
                status={latestView.items}
                formatExpiresAt={(instant) =>
                  format.dateTime(
                    new Date(Temporal.Instant.from(instant).epochMilliseconds),
                    MEDIUM_DATE_SHORT_TIME_FORMAT,
                  )
                }
              />
            </>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
};

type PersonalDataExportStatusProps = {
  status: AccountDataExportStatusData;
  requestPending: boolean;
  onRequest: () => void;
  formatExpiresAt: (
    instant: Extract<
      AccountDataExportStatusData,
      { status: "ready" }
    >["expiresAt"],
  ) => string;
};

const PersonalDataExportStatus = ({
  status,
  requestPending,
  onRequest,
  formatExpiresAt,
}: PersonalDataExportStatusProps) => {
  const t = useTranslations();

  switch (status.status) {
    case "requested":
    case "processing":
      return (
        <div
          role="status"
          className="text-muted-foreground flex items-center gap-2 text-sm"
        >
          <Loader size="sm" variant="decorative" />
          {t("settings.account.personalDataExportWorking")}
        </div>
      );
    case "ready":
      return (
        <div className="flex flex-col items-start gap-3">
          <div className="space-y-1">
            <p role="status" className="text-sm">
              {t("settings.account.personalDataExportReady")}
            </p>
            <p className="text-muted-foreground text-sm">
              {t("settings.account.personalDataExportExpiresAt", {
                expiresAt: formatExpiresAt(status.expiresAt),
              })}
            </p>
          </div>
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
        </div>
      );
    case "failed":
      return (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-destructive text-sm">
            {t("settings.account.personalDataExportFailed")}
          </p>
          <Button
            disabled={requestPending}
            loading={requestPending}
            onClick={onRequest}
            size="sm"
            variant="outline"
          >
            {t("settings.account.personalDataExportRequestNew")}
          </Button>
        </div>
      );
    case "expired":
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground text-sm">
            {t("settings.account.personalDataExportExpired")}
          </p>
          <Button
            disabled={requestPending}
            loading={requestPending}
            onClick={onRequest}
            size="sm"
            variant="outline"
          >
            {t("settings.account.personalDataExportRequestNew")}
          </Button>
        </div>
      );
    default: {
      status satisfies never;
      return panic("Unhandled personal data export status");
    }
  }
};
