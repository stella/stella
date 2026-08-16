import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { env } from "@/env";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { usageLaneOptions } from "@/lib/usage-queries";

/**
 * Inline notice shown when the user's included daily AI budget is spent
 * and the organization's plan still serves reduced-cost fallback turns:
 * chat keeps working, so this states the change rather than blocking.
 * Renders nothing while the lane state is unknown, when the plan
 * declares no per-user budgets, when the daily budget still has room,
 * or when no fallback budget exists (that case is a hard stop and is
 * surfaced by the usage-limit modal instead).
 */
export const UsageFallbackNotice = () => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data } = useQuery({
    ...usageLaneOptions({ organizationId: activeOrganizationId }),
    enabled: env.VITE_FEATURE_USAGE,
    // Turns settle counters server-side with no client event to hook,
    // so the mounted notice re-reads its single-row state on an
    // interval instead of coupling into the chat runtime.
    refetchInterval: 60_000,
  });

  const budgets = data?.budgets;
  if (!budgets || budgets.fallbackWeekly === null) {
    return null;
  }
  if (budgets.daily.usedMicroUnits < budgets.daily.allowanceMicroUnits) {
    return null;
  }
  // Weekly fallback spent too: routing has moved on from the reduced-
  // cost lane, so this notice would be wrong; the hard-stop surface
  // (usage-limit modal) owns that state.
  if (
    budgets.fallbackWeekly.usedMicroUnits >=
    budgets.fallbackWeekly.allowanceMicroUnits
  ) {
    return null;
  }

  return (
    <div className="bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-sm">
      {t("chat.usageFallbackNotice")}
    </div>
  );
};
