import { useState } from "react";

import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";

import { env } from "@/env";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import { organizationAccessOptions } from "@/lib/usage-queries";
import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";

const ACCESS_REFRESH_INTERVAL_MS = 60_000;

export const PaymentRetryBanner = () => {
  const t = useTranslations();
  const format = useFormatter();
  const canUseChat = usePermissions({ chat: ["create"] });
  const { activeOrganizationId } = useAuthenticatedUser();
  const [now, setNow] = useState(
    () => Temporal.Now.instant().epochMilliseconds,
  );
  const accessView = useQueryView(
    useChromeQuery({
      ...organizationAccessOptions({ organizationId: activeOrganizationId }),
      enabled: env.VITE_FEATURE_USAGE && canUseChat,
      refetchInterval: (query) => {
        const retry = query.state.data?.paymentRetry;
        if (retry?.status !== "payment_retry") {
          return ACCESS_REFRESH_INTERVAL_MS;
        }
        const endsAt = parseDeterministicDate(retry.endsAt)?.getTime();
        const currentTime = Temporal.Now.instant().epochMilliseconds;
        if (endsAt === undefined || endsAt <= currentTime) {
          return ACCESS_REFRESH_INTERVAL_MS;
        }
        return Math.min(ACCESS_REFRESH_INTERVAL_MS, endsAt - currentTime);
      },
    }),
  );
  useQueryViewError(accessView);
  const data = accessView.type === "items" ? accessView.items : undefined;
  const retryEndsAt =
    data?.paymentRetry.status === "payment_retry"
      ? parseDeterministicDate(data.paymentRetry.endsAt)?.getTime()
      : undefined;
  useExternalSyncEffect(() => {
    if (retryEndsAt === undefined || retryEndsAt <= now) {
      return undefined;
    }
    const timer = window.setTimeout(
      () => setNow(Temporal.Now.instant().epochMilliseconds),
      Math.max(
        0,
        Math.min(
          ACCESS_REFRESH_INTERVAL_MS,
          retryEndsAt - Temporal.Now.instant().epochMilliseconds,
        ),
      ),
    );
    return () => window.clearTimeout(timer);
  }, [now, retryEndsAt]);
  if (data?.paymentRetry.status !== "payment_retry") {
    return null;
  }
  if (retryEndsAt === undefined || retryEndsAt <= now) {
    return null;
  }
  return (
    <div
      className="bg-muted/40 text-muted-foreground border-b px-4 py-2 text-sm"
      role="status"
    >
      {t("common.paymentRetryNotice", {
        date: format.dateTime(new Date(retryEndsAt), { dateStyle: "long" }),
      })}
    </div>
  );
};
