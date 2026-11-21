import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { cn } from "@stll/ui/utils";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useFormatter } from "@/i18n/formatting-context";
import { accountDataExportLatestOptions } from "@/lib/account/account-data-export-queries";
import type { AccountDataExportStatus as AccountDataExportStatusData } from "@/lib/account/account-data-export-queries";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { useQueryViewError } from "@/lib/use-query-view";
import {
  PersonalDataExportCardFrame,
  PersonalDataExportDescription,
  PersonalDataExportStatusPending,
} from "@/routes/_protected.settings/-components/account/personal-data-export-card.pending";

export const PersonalDataExportCard = () => {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { id: userId } = useAuthenticatedUser();
  const latestOptions = accountDataExportLatestOptions(userId);
  const latestQuery = useQuery(latestOptions);
  const latestView = queryView(latestQuery, {
    isEmpty: (data) => data === null,
  });
  useQueryViewError(latestView, "PersonalDataExportCard:latest");

  const requestExport = useMutation({
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: latestOptions.queryKey });
    },
    mutationFn: async () =>
      await invokeCapability("account-exports.create", async (request) =>
        unwrapApiResponse(
          await api.me["data-exports"].post(undefined, request),
        ),
      ),
    onSuccess: async (status) => {
      queryClient.setQueryData(latestOptions.queryKey, status);
      await queryClient.invalidateQueries({ queryKey: latestOptions.queryKey });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "PersonalDataExportCard:request",
        scope: { type: "handler", handlerId: "PersonalDataExportCard:request" },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const requestButton = (label: string) => (
    <Button
      disabled={requestExport.isPending}
      disabledReason={t("common.preparing")}
      loading={requestExport.isPending}
      onClick={() => requestExport.mutate()}
      size="sm"
      variant="outline"
    >
      {label}
    </Button>
  );

  const exportState = (status: AccountDataExportStatusData): ExportState => {
    switch (status.status) {
      case "requested":
      case "processing":
        return {
          action: "preparing",
          line: t("settings.account.personalDataExportWorking"),
          tone: "normal",
        };
      case "ready":
        return {
          action: "download",
          id: status.id,
          line: t("settings.account.personalDataExportReady", {
            expiresAt: format.dateTime(
              new Date(
                Temporal.Instant.from(status.expiresAt).epochMilliseconds,
              ),
              MEDIUM_DATE_SHORT_TIME_FORMAT,
            ),
          }),
          tone: "normal",
        };
      case "failed":
        return {
          action: "prepareAgain",
          line: t("settings.account.personalDataExportFailed"),
          tone: "failed",
        };
      case "expired":
        return {
          action: "prepareAgain",
          line: t("settings.account.personalDataExportExpired"),
          tone: "normal",
        };
      default:
        status satisfies never;
        return panic("Unhandled personal data export status");
    }
  };

  const exportAction = (state: ExportState) => {
    switch (state.action) {
      case "download":
        return (
          <Button
            render={
              <a
                download
                href={sanitizeHref(
                  apiUrl(
                    `/me/data-exports/${encodeURIComponent(state.id)}/download`,
                  ),
                )}
              />
            }
            size="sm"
          >
            <DownloadIcon className="size-3.5" />
            {t("common.download")}
          </Button>
        );
      case "preparing":
        return (
          <Button
            disabled
            disabledReason={t("common.preparing")}
            size="sm"
            variant="outline"
          >
            <Loader size="sm" variant="decorative" />
            {t("settings.account.personalDataExportPreparing")}
          </Button>
        );
      case "prepareAgain":
        return requestButton(
          t("settings.account.personalDataExportRequestNew"),
        );
      default:
        state satisfies never;
        return panic("Unhandled personal data export action");
    }
  };

  const noExport = (
    <PersonalDataExportCardFrame
      action={requestButton(t("settings.account.personalDataExportRequest"))}
      description={<PersonalDataExportDescription />}
    />
  );

  switch (latestView.type) {
    case "pending":
      return (
        <PersonalDataExportCardFrame
          action={<PersonalDataExportStatusPending />}
          description={<PersonalDataExportDescription />}
        />
      );
    case "error":
      return (
        <PersonalDataExportCardFrame
          action={null}
          description={<PersonalDataExportDescription />}
          footer={<QueryViewFeedback view={latestView} />}
        />
      );
    case "empty":
      return noExport;
    case "items": {
      if (latestView.items === null) {
        // A failed refresh of "no export yet" keeps its retry.
        return (
          <PersonalDataExportCardFrame
            action={requestButton(
              t("settings.account.personalDataExportRequest"),
            )}
            description={<PersonalDataExportDescription />}
            footer={<QueryViewFeedback view={latestView} />}
          />
        );
      }
      const state = exportState(latestView.items);
      return (
        <PersonalDataExportCardFrame
          action={exportAction(state)}
          description={
            <span
              className={cn(
                state.tone === "failed" && "text-destructive-foreground",
              )}
              role={state.tone === "failed" ? "alert" : "status"}
            >
              {state.line}
            </span>
          }
          footer={<QueryViewFeedback view={latestView} />}
        />
      );
    }
    default:
      latestView satisfies never;
      return panic("Unhandled personal data export view");
  }
};

/** What an export's state says, and the one step it offers next. */
type ExportState = {
  line: string;
  tone: "normal" | "failed";
} & (
  | { action: "download"; id: string }
  | { action: "preparing" }
  | { action: "prepareAgain" }
);
