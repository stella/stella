import { useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useFormatter, useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { usageEntitlementOptions } from "@/routes/_protected.settings/-queries/usage";
import type { UsageEntitlement } from "@/routes/_protected.settings/-queries/usage";

export const Route = createFileRoute("/_protected/settings/organization/usage")(
  {
    component: UsageSettingsPage,
  },
);

function UsageSettingsPage() {
  const t = useTranslations();
  const activeOrganizationId = Route.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data, isLoading } = useQuery(
    usageEntitlementOptions({ organizationId: activeOrganizationId }),
  );

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.usageDescription")}
        title={t("settings.organization.usage")}
      />
      <UsageBody data={data?.entitlement ? data : null} isLoading={isLoading} />
    </>
  );
}

function UsageBody({
  data,
  isLoading,
}: {
  data: UsageEntitlement | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <EntitlementCardSkeleton />;
  }
  if (data) {
    return <ActiveEntitlementCard data={data} />;
  }
  return <EmptyStateCard />;
}

// Mirrors ActiveEntitlementCard: title + meta row with a trailing action,
// then the usage label/value row above the meter, so the card does not
// jump when the entitlement query resolves.
function EntitlementCardSkeleton() {
  return (
    <Frame>
      <FramePanel>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>

        <div className="mt-6 space-y-2">
          <div className="flex justify-between gap-4">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
      </FramePanel>
    </Frame>
  );
}

function ActiveEntitlementCard({ data }: { data: UsageEntitlement }) {
  const t = useTranslations();
  const format = useFormatter();
  const monthlyAllowance =
    data.policy.monthlyUsageUnitsPerSeat * data.entitlement.seats;
  const usedPct =
    monthlyAllowance > 0
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((monthlyAllowance - data.remainingUsageUnits) /
                monthlyAllowance) *
                100,
            ),
          ),
        )
      : 0;

  return (
    <Frame>
      <FramePanel>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-medium">
              <BidiText>{data.policy.displayName}</BidiText>
            </h2>
            <p className="text-muted-foreground text-sm">
              {data.entitlement.cancelAtPeriodEnd
                ? t("settings.organization.usageEndsOnTemplate", {
                    date: formatShortDate(
                      data.entitlement.currentPeriodEnd,
                      format,
                    ),
                  })
                : t(USAGE_STATUS_KEYS[data.entitlement.status])}{" "}
              ·{" "}
              {t("settings.organization.usageSeats", {
                count: data.entitlement.seats,
              })}{" "}
              ·{" "}
              {formatPeriod(
                data.entitlement.currentPeriodStart,
                data.entitlement.currentPeriodEnd,
                format,
              )}
            </p>
          </div>
          {data.entitlement.source === "hosted" ? (
            <ManageUsageButton />
          ) : (
            <span className="text-muted-foreground text-xs">
              {t("settings.organization.usageManuallyManaged")}
            </span>
          )}
        </div>

        <div className="mt-6 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {t("settings.organization.usageUnitsThisPeriod")}
            </span>
            <span className="font-medium">
              {t("settings.organization.usageUnitsBalanceTemplate", {
                remaining: format.number(data.remainingUsageUnits),
              })}
            </span>
          </div>
          <div
            aria-label={t("settings.organization.usageUnitsThisPeriod")}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={usedPct}
            className="bg-muted h-2 w-full overflow-hidden rounded-full"
            role="progressbar"
          >
            <div
              className="bg-foreground h-full transition-[width]"
              style={{ width: `${usedPct}%` }}
            />
          </div>
        </div>
      </FramePanel>
    </Frame>
  );
}

function ManageUsageButton() {
  const t = useTranslations();
  const [pending, setPending] = useState(false);
  const mutation = useMutation({
    mutationFn: async () => {
      const response = await api.usage.hosted.management.post();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onMutate: () => setPending(true),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (error: unknown) => {
      setPending(false);
      stellaToast.add({
        title: t("settings.organization.usageManageError"),
        description: error instanceof Error ? error.message : undefined,
        type: "error",
      });
    },
  });

  return (
    <Button
      disabled={pending}
      onClick={() => mutation.mutate()}
      variant="ghost"
    >
      {t("settings.organization.usageManage")}
    </Button>
  );
}

function EmptyStateCard() {
  const t = useTranslations();
  return (
    <Frame>
      <FramePanel>
        <h2 className="text-lg font-medium">
          {t("settings.organization.usageEmptyTitle")}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("settings.organization.usageEmptyDescription")}
        </p>
      </FramePanel>
    </Frame>
  );
}

type IntlFormatter = ReturnType<typeof useFormatter>;

const SHORT_DATE_OPTIONS = {
  month: "short",
  day: "numeric",
  year: "numeric",
} as const;

const formatShortDate = (iso: string, format: IntlFormatter): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return format.dateTime(date, SHORT_DATE_OPTIONS);
};

const formatPeriod = (
  start: string,
  end: string,
  format: IntlFormatter,
): string => {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return "";
  }
  return `${format.dateTime(s, SHORT_DATE_OPTIONS)} - ${format.dateTime(e, SHORT_DATE_OPTIONS)}`;
};

const USAGE_STATUS_KEYS = {
  trialing: "settings.organization.usageStatusTrialing",
  active: "settings.organization.usageStatusActive",
  past_due: "settings.organization.usageStatusPastDue",
  cancelled: "settings.organization.usageStatusCancelled",
  paused: "settings.organization.usageStatusPaused",
} as const satisfies Record<
  UsageEntitlement["entitlement"]["status"],
  TranslationKey
>;
