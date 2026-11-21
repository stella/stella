import { useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { toMajorUnits } from "@stll/money";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Label } from "@stll/ui/label";
import { NumberInput } from "@stll/ui/number-input";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { usagePoliciesOptions } from "@/routes/_protected.settings/organization/-queries/usage-policies";
import type { UsagePolicyEntry } from "@/routes/_protected.settings/organization/-queries/usage-policies";

import {
  UsagePlanRowFace,
  UsagePlanSection,
  UsagePlansPending,
} from "./usage-plans-card.pending";

/**
 * Catalog of subscription plans and one-time packs with hosted checkout.
 * Rendered only behind the usage feature flag; on deployments without a
 * seeded catalog the empty list renders nothing at all.
 */
export function UsagePlansCard({
  packCheckoutDisabledReason,
}: {
  /**
   * Add-on checkout requires a consumable hosted entitlement.
   */
  packCheckoutDisabledReason: string | undefined;
}) {
  const t = useTranslations();
  const { data, isLoading, isError, refetch } = useQuery(usagePoliciesOptions);

  if (isLoading) {
    return <UsagePlansPending />;
  }
  // A failed catalog read must not masquerade as an empty catalog:
  // purchasing silently vanishing is indistinguishable from "nothing
  // for sale" and would hide real outages.
  if (isError) {
    return (
      <SettingsSection>
        <SettingsPanel>
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
        </SettingsPanel>
      </SettingsSection>
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
        <UsagePlanSection kind="subscription">
          {subscriptions.map((policy) => (
            <PolicyRow key={policy.id} policy={policy} withSeats />
          ))}
        </UsagePlanSection>
      )}
      {packs.length > 0 && (
        <UsagePlanSection kind="addon">
          {packs.map((policy) => (
            <PolicyRow
              key={policy.id}
              policy={policy}
              entitlementBlocker={packCheckoutDisabledReason}
              withSeats={false}
            />
          ))}
        </UsagePlanSection>
      )}
    </>
  );
}

const MIN_SEATS = 1;
const MAX_SEATS = 1000;

type CheckoutBlockerOptions = {
  pending: boolean;
  entitlementBlocker: string | undefined;
  checkout: UsagePolicyEntry["hostedCheckout"];
};

const checkoutBlocker = (
  { pending, entitlementBlocker, checkout }: CheckoutBlockerOptions,
  t: (
    key:
      | "common.preparing"
      | "settings.organization.usageCheckoutProviderUnavailable"
      | "settings.organization.usagePlanCheckoutUnavailable",
  ) => string,
) => {
  if (pending) {
    return t("common.preparing");
  }
  if (entitlementBlocker !== undefined) {
    return entitlementBlocker;
  }
  if (checkout.status === "available") {
    return undefined;
  }
  switch (checkout.reason) {
    case "provider_unavailable":
      return t("settings.organization.usageCheckoutProviderUnavailable");
    case "policy_unavailable":
      return t("settings.organization.usagePlanCheckoutUnavailable");
    default:
      checkout.reason satisfies never;
      return panic("Unhandled checkout blocker");
  }
};

function PolicyRow({
  policy,
  entitlementBlocker,
  withSeats,
}: {
  policy: UsagePolicyEntry;
  entitlementBlocker?: string | undefined;
  withSeats: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const [seats, setSeats] = useState(MIN_SEATS);
  const [pending, setPending] = useState(false);
  const perSeat = policy.price?.basis === "per_seat";
  const seatsInputId = `usage-plan-seats-${policy.id}`;
  const disabledReason = checkoutBlocker(
    { pending, entitlementBlocker, checkout: policy.hostedCheckout },
    t,
  );

  const checkout = useMutation({
    mutationFn: async () => {
      const response = await api.usage.hosted.setup.post({
        usagePolicyId: policy.id,
        ...(withSeats && perSeat ? { seats } : {}),
      });
      return unwrapApiResponse(response);
    },
    onMutate: () => setPending(true),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (error: unknown) => {
      setPending(false);
      notifyUserError(
        error,
        t("settings.organization.usagePlanCheckoutError"),
        { description: userErrorFromThrown(error, t("errors.actionFailed")) },
      );
    },
  });

  return (
    <UsagePlanRowFace
      actions={
        <>
          {withSeats && perSeat && (
            <>
              <Label htmlFor={seatsInputId} variant="muted">
                {t("settings.organization.usagePlanSeats")}
              </Label>
              <NumberInput
                className="w-20"
                id={seatsInputId}
                max={MAX_SEATS}
                min={MIN_SEATS}
                onValueChange={(next) => {
                  if (next !== null && Number.isInteger(next)) {
                    setSeats(Math.min(Math.max(next, MIN_SEATS), MAX_SEATS));
                  }
                }}
                size="sm"
                step={1}
                value={seats}
              />
            </>
          )}
          <Button
            disabled={disabledReason !== undefined}
            disabledReason={disabledReason}
            onClick={() => checkout.mutate()}
          >
            {t("settings.organization.usagePlanCheckout")}
          </Button>
        </>
      }
      description={
        policy.description ? (
          <BidiText>{policy.description}</BidiText>
        ) : undefined
      }
      offerLine={
        policy.price
          ? t(PRICE_TEMPLATE_KEYS[priceShapeOf(policy.price)], {
              price: format.number(
                toMajorUnits({
                  amountCents: policy.price.amountCents,
                  currency: policy.price.currency,
                }),
                { style: "currency", currency: policy.price.currency },
              ),
            })
          : undefined
      }
      title={<BidiText>{policy.displayName}</BidiText>}
    />
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
