import { useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { toMajorUnits } from "@stll/money";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { usagePoliciesOptions } from "@/routes/_protected.settings/-queries/usage-policies";
import type { UsagePolicyEntry } from "@/routes/_protected.settings/-queries/usage-policies";

/**
 * Catalog of subscription plans and one-time packs with hosted checkout.
 * Rendered only behind the usage feature flag; on deployments without a
 * seeded catalog the empty list renders nothing at all.
 */
export function UsagePlansCard({
  packsPurchasable,
}: {
  /**
   * Whether the organisation can buy add-on packs right now (a
   * consumable hosted entitlement exists). The server enforces this
   * on setup; the flag keeps the button honest instead of letting a
   * click round-trip into a rejection.
   */
  packsPurchasable: boolean;
}) {
  const t = useTranslations();
  const { data, isLoading, isError, refetch } = useQuery(usagePoliciesOptions);

  if (isLoading) {
    return <PlansSkeleton />;
  }
  // A failed catalog read must not masquerade as an empty catalog:
  // purchasing silently vanishing is indistinguishable from "nothing
  // for sale" and would hide real outages.
  if (isError) {
    return (
      <Frame>
        <FramePanel>
          <p className="text-muted-foreground text-sm">
            {t("errors.actionFailed")}
          </p>
          <Button
            className="mt-3"
            onClick={() => {
              detached(refetch(), "usage-plans.refetch-catalog");
            }}
            variant="ghost"
          >
            {t("common.retry")}
          </Button>
        </FramePanel>
      </Frame>
    );
  }
  // Unseeded deployment: nothing to sell, render nothing.
  if (!data) {
    return null;
  }
  const subscriptions = data.policies.filter(
    (policy) => policy.kind === "subscription",
  );
  const packs = data.policies.filter((policy) => policy.kind === "addon");
  if (subscriptions.length === 0 && packs.length === 0) {
    return null;
  }

  return (
    <>
      {subscriptions.length > 0 && (
        <Frame>
          <FramePanel>
            <h2 className="text-lg font-medium">
              {t("settings.organization.usagePlansTitle")}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("settings.organization.usagePlansDescription")}
            </p>
            <ul className="mt-4 space-y-3">
              {subscriptions.map((policy) => (
                <PolicyRow
                  key={policy.id}
                  policy={policy}
                  purchasable
                  withSeats
                />
              ))}
            </ul>
          </FramePanel>
        </Frame>
      )}
      {packs.length > 0 && (
        <Frame>
          <FramePanel>
            <h2 className="text-lg font-medium">
              {t("settings.organization.usagePacksTitle")}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("settings.organization.usagePacksDescription")}
            </p>
            <ul className="mt-4 space-y-3">
              {packs.map((policy) => (
                <PolicyRow
                  key={policy.id}
                  policy={policy}
                  purchasable={packsPurchasable}
                  withSeats={false}
                />
              ))}
            </ul>
          </FramePanel>
        </Frame>
      )}
    </>
  );
}

function PlansSkeleton() {
  return (
    <Frame>
      <FramePanel>
        <Skeleton className="h-6 w-32" />
        <Skeleton className="mt-2 h-4 w-64 max-w-full" />
        <div className="mt-4 space-y-3">
          <Skeleton className="h-14 w-full rounded-md" />
          <Skeleton className="h-14 w-full rounded-md" />
        </div>
      </FramePanel>
    </Frame>
  );
}

const MIN_SEATS = 1;
const MAX_SEATS = 1000;

function PolicyRow({
  policy,
  purchasable,
  withSeats,
}: {
  policy: UsagePolicyEntry;
  purchasable: boolean;
  withSeats: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const [seats, setSeats] = useState(MIN_SEATS);
  const [pending, setPending] = useState(false);
  const perSeat = policy.price?.basis === "per_seat";
  const seatsInputId = `usage-plan-seats-${policy.id}`;

  const checkout = useMutation({
    mutationFn: async () => {
      const response = await api.usage.hosted.setup.post({
        usagePolicyId: policy.id,
        ...(withSeats && perSeat ? { seats } : {}),
      });
      return unwrapEden(response);
    },
    onMutate: () => setPending(true),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (error: unknown) => {
      setPending(false);
      stellaToast.add({
        title: t("settings.organization.usagePlanCheckoutError"),
        description: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });

  return (
    <li className="border-border flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">
          <BidiText>{policy.displayName}</BidiText>
        </div>
        {policy.description && (
          <p className="text-muted-foreground text-sm">
            <BidiText>{policy.description}</BidiText>
          </p>
        )}
        {policy.price && (
          <p className="text-sm">
            {t(PRICE_TEMPLATE_KEYS[priceShapeOf(policy.price)], {
              price: format.number(
                toMajorUnits({
                  amountCents: policy.price.amountCents,
                  currency: policy.price.currency,
                }),
                { style: "currency", currency: policy.price.currency },
              ),
            })}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {withSeats && perSeat && (
          <>
            <label
              className="text-muted-foreground text-sm"
              htmlFor={seatsInputId}
            >
              {t("settings.organization.usagePlanSeats")}
            </label>
            <input
              className="border-input bg-background h-8 w-20 rounded-md border px-2 text-sm"
              id={seatsInputId}
              max={MAX_SEATS}
              min={MIN_SEATS}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                if (Number.isInteger(parsed)) {
                  setSeats(Math.min(Math.max(parsed, MIN_SEATS), MAX_SEATS));
                }
              }}
              type="number"
              value={seats}
            />
          </>
        )}
        <Button
          disabled={
            pending ||
            !purchasable ||
            policy.hostedCheckout.status !== "available"
          }
          onClick={() => checkout.mutate()}
        >
          {t("settings.organization.usagePlanCheckout")}
        </Button>
      </div>
    </li>
  );
}

type PolicyPrice = NonNullable<UsagePolicyEntry["price"]>;
type PriceShape = `${PolicyPrice["basis"]}_${PolicyPrice["billingInterval"]}`;

const priceShapeOf = (price: PolicyPrice): PriceShape =>
  `${price.basis}_${price.billingInterval}`;

// Total over every basis × interval combination so a new catalog shape
// cannot land without a rendering decision.
const PRICE_TEMPLATE_KEYS = {
  flat_month: "settings.organization.usagePlanPriceMonthTemplate",
  flat_year: "settings.organization.usagePlanPriceYearTemplate",
  flat_one_time: "settings.organization.usagePlanPriceOneTimeTemplate",
  per_seat_month: "settings.organization.usagePlanPriceSeatMonthTemplate",
  per_seat_year: "settings.organization.usagePlanPriceSeatYearTemplate",
  per_seat_one_time: "settings.organization.usagePlanPriceOneTimeTemplate",
} as const satisfies Record<PriceShape, TranslationKey>;
