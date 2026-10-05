import type { QueryClient } from "@tanstack/react-query";

import { env } from "@/env";
import { useFeatureAccess } from "@/hooks/use-feature-access";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { useDevStore } from "@/lib/dev-store";
import { ensureRouteQueryData } from "@/lib/react-query";
import { featureAccessOptions } from "@/queries/feature-access";
import { featureIsEnabled } from "@/queries/feature-access.logic";
import { loadAuthContext } from "@/routes/-auth-context";

// AVT verifies documents against a legal list's facts, so it needs the lists
// deployment feature as well as the per-browser beta opt-in.
const isAvtPreviewEnabledForDevState = (devPreviewEnabled: boolean): boolean =>
  env.VITE_FEATURE_LEGAL_LISTS && betaFeaturesAvailable() && devPreviewEnabled;

export const isAvtPreviewEnabled = async (
  queryClient: QueryClient,
): Promise<boolean> => {
  if (!isAvtPreviewEnabledForDevState(useDevStore.getState().avtPreview)) {
    return false;
  }
  const { session } = await loadAuthContext(queryClient);
  if (!session?.activeOrganizationId) {
    return false;
  }
  const principal = {
    organizationId: session.activeOrganizationId,
    userId: session.userId,
  };
  const access = await ensureRouteQueryData(
    queryClient,
    featureAccessOptions(principal),
  );
  return featureIsEnabled(access, principal, "list-verification");
};

export const useAvtPreviewEnabled = (): boolean => {
  const verificationEnabled = useFeatureAccess("list-verification");
  const devPreviewEnabled = useDevStore((s) => s.avtPreview);
  return (
    verificationEnabled && isAvtPreviewEnabledForDevState(devPreviewEnabled)
  );
};
