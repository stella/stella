import { useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Frame, FramePanel } from "@stll/ui/components/frame";
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
      <UsageBody data={data ?? null} isLoading={isLoading} />
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
  const t = useTranslations();
  if (isLoading) {
    return <FramePanel>{t("settings.organization.usageLoading")}</FramePanel>;
  }
  if (data) {
    return <ActiveEntitlementCard data={data} />;
  }
  return <EmptyStateCard />;
}

function ActiveEntitlementCard({ data }: { data: UsageEntitlement }) {
  const t = useTranslations();
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
            <h2 className="text-lg font-medium">{data.policy.displayName}</h2>
            <p className="text-muted-foreground text-sm">
              {data.entitlement.cancelAtPeriodEnd
                ? t("settings.organization.usageEndsOnTemplate", {
                    date: formatShortDate(data.entitlement.currentPeriodEnd),
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
                remaining: data.remainingUsageUnits.toLocaleString(),
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
              className="bg-foreground h-full transition-all"
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

const formatShortDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
};

const formatPeriod = (start: string, end: string): string => {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return "";
  }
  const fmt = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${fmt.format(s)} - ${fmt.format(e)}`;
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
