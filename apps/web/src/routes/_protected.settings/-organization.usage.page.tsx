import { useState } from "react";
import type { ReactNode } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { createHostedUsageManagementSession } from "@/components/usage/usage-limit-modal";
import { env } from "@/env";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryAvailability } from "@/lib/organization/feature-access/availability";
import { queryView } from "@/lib/query-view.logic";
import { usageEntitlementOptions } from "@/lib/usage-queries";
import type { UsageEntitlement } from "@/lib/usage-queries";
import { UsagePlansCard } from "@/routes/_protected.settings/organization/-components/organization/usage-plans-card";

import {
  ActiveEntitlementCardFace,
  EntitlementPending,
  UsageShell,
} from "./-organization.usage.pending";

const usageRoute = getRouteApi("/_protected/settings/organization/usage");

export function UsageSettingsPage() {
  const t = useTranslations();
  const activeOrganizationId = usageRoute.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const entitlementQuery = useQuery(
    usageEntitlementOptions({ organizationId: activeOrganizationId }),
  );
  const entitlementView = queryView(entitlementQuery);
  const availability = queryAvailability(
    env.VITE_FEATURE_USAGE,
    entitlementView,
  );
  let content: ReactNode;
  let packCheckoutDisabledReason: string | undefined;
  switch (availability.status) {
    case "disabled":
      return null;
    case "pending":
      content = <EntitlementPending />;
      packCheckoutDisabledReason = t("common.loading");
      break;
    case "error":
      content = <QueryViewFeedback view={entitlementView} />;
      packCheckoutDisabledReason = t("common.loadFailed");
      break;
    case "ready": {
      const data = availability.value;
      const entitlement = data?.entitlement;
      const packsPurchasable =
        entitlement?.source === "hosted" &&
        (entitlement.status === "active" || entitlement.status === "trialing");
      if (!packsPurchasable) {
        packCheckoutDisabledReason = t(
          "settings.organization.usagePacksRequireActivePlan",
        );
      }
      content = (
        <>
          <QueryViewFeedback view={entitlementView} />
          {data?.entitlement ? (
            <ActiveEntitlementCard data={data} />
          ) : (
            <EmptyStateCard />
          )}
        </>
      );
      break;
    }
    default:
      availability satisfies never;
      return panic("Unknown usage entitlement availability");
  }

  return (
    <UsageShell
      plans={
        <UsagePlansCard
          packCheckoutDisabledReason={packCheckoutDisabledReason}
        />
      }
    >
      {content}
    </UsageShell>
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
    <ActiveEntitlementCardFace
      action={
        data.entitlement.source === "hosted" ? (
          <ManageUsageButton />
        ) : (
          <span className="text-muted-foreground text-xs">
            {t("settings.organization.usageManuallyManaged")}
          </span>
        )
      }
      remainingUsage={t("settings.organization.usageUnitsBalanceTemplate", {
        remaining: format.number(data.remainingUsageUnits),
      })}
      formattedUsage={format.number(usedPct / 100, { style: "percent" })}
      summary={
        <>
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
        </>
      }
      title={<BidiText>{data.policy.displayName}</BidiText>}
    />
  );
}

function ManageUsageButton() {
  const t = useTranslations();
  const [pending, setPending] = useState(false);
  const mutation = useMutation({
    mutationFn: createHostedUsageManagementSession,
    onMutate: () => setPending(true),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (error: unknown) => {
      setPending(false);
      notifyUserError(error, t("settings.organization.usageManageError"), {
        description: userErrorFromThrown(error, t("errors.actionFailed")),
      });
    },
  });

  return (
    <Button
      disabled={pending}
      disabledReason={t("common.preparing")}
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
    <SettingsSection title={t("settings.organization.usageEmptyTitle")}>
      <SettingsPanel>
        <p className="text-muted-foreground text-sm">
          {t("settings.organization.usageEmptyDescription")}
        </p>
      </SettingsPanel>
    </SettingsSection>
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
  active: "common.active",
  past_due: "settings.organization.usageStatusPastDue",
  cancelled: "settings.organization.usageStatusCancelled",
  paused: "settings.organization.usageStatusPaused",
} as const satisfies Record<
  UsageEntitlement["entitlement"]["status"],
  TranslationKey
>;
