import type { QueryState } from "@tanstack/react-query";
import { panic } from "better-result";

import { submittedRateCents } from "@/components/billing/amount-input.logic";
import { DEFAULT_CURRENCY } from "@/components/billing/format-currency";
import type { resolvedRateOptions } from "@/lib/workspaces/queries/rates";

export type TimeEntryPricingSelection =
  { type: "automatic" } | { type: "manual"; draft: string; currency: string };

type RateResolution = Awaited<
  ReturnType<NonNullable<ReturnType<typeof resolvedRateOptions>["queryFn"]>>
>;

type DeriveTimeEntryPricingOptions = {
  selection: TimeEntryPricingSelection;
  lookup:
    | Pick<QueryState<RateResolution>, "status" | "fetchStatus" | "data">
    | undefined;
};

/** Automatic prices belong to the current lookup; only manual prices are stored. */
export const deriveTimeEntryPricing = ({
  selection,
  lookup,
}: DeriveTimeEntryPricingOptions) => {
  let status: "pending" | "ready" | "error" = "pending";
  if (
    lookup !== undefined &&
    lookup.status !== "pending" &&
    lookup.fetchStatus !== "fetching"
  ) {
    status =
      selection.type === "manual" || lookup.status === "success"
        ? "ready"
        : "error";
  }
  switch (selection.type) {
    case "manual":
      return {
        status,
        rateAtEntry: submittedRateCents({
          draft: selection.draft,
          currency: selection.currency,
          resolvedRateCents: 0,
        }),
        currency: selection.currency,
      };
    case "automatic": {
      const resolved = lookup?.status === "success" ? lookup.data : undefined;
      if (
        resolved &&
        resolved.hourlyRate !== null &&
        resolved.currency !== null
      ) {
        return {
          status,
          rateAtEntry: resolved.hourlyRate,
          currency: resolved.currency,
        };
      }
      return { status, rateAtEntry: 0, currency: DEFAULT_CURRENCY };
    }
    default:
      selection satisfies never;
      return panic("Unhandled time-entry pricing selection");
  }
};
