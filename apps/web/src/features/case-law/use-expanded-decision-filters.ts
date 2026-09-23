import { useQuery } from "@tanstack/react-query";

import type { DecisionQueryIntent } from "@stll/api-contract/decision-query-intent";

import {
  caseLawQueryExpansionOptions,
  type DecisionListFilters,
} from "@/features/case-law/queries/decisions";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useAnalytics } from "@/lib/analytics/provider";

/**
 * The search filters with the legal-vocabulary alternatives the reader's
 * organization's model proposes for their words ("kauce" beside "jistota").
 *
 * Signed-in readers only: a visitor's search runs as typed, because the public
 * page spends no AI on its own account. Never asked for a strict search or an
 * identifier, which are matched as written. The filters come back as typed
 * until the alternatives land, so the rows first answer the words as typed and
 * the model never holds the search up.
 */
export const useExpandedDecisionFilters = (
  typed: DecisionListFilters,
  intent: DecisionQueryIntent,
): DecisionListFilters => {
  const authStatus = useClientAuthStatus();
  const analytics = useAnalytics();
  const query = typed.search ?? "";
  const { data: expansion } = useQuery({
    ...caseLawQueryExpansionOptions({
      activeOrganizationId:
        authStatus.status === "authenticated"
          ? authStatus.user.activeOrganizationId
          : "",
      country: typed.country,
      onFailure: (failure) => analytics.captureError(failure),
      query,
    }),
    enabled:
      authStatus.status === "authenticated" &&
      intent.type === "text" &&
      query.length > 0 &&
      typed.strict === undefined,
  });
  const alternatives = expansion?.alternatives ?? [];
  return alternatives.length === 0 ? typed : { ...typed, alternatives };
};
