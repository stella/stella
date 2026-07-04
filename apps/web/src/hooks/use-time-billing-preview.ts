import { env } from "@/env";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { useDevStore } from "@/lib/dev-store";

const isTimeBillingPreviewEnabledForDevState = (
  devPreviewEnabled: boolean,
): boolean =>
  env.VITE_FEATURE_TIME_BILLING ||
  (betaFeaturesAvailable() && devPreviewEnabled);

export const isTimeBillingPreviewEnabled = (): boolean =>
  isTimeBillingPreviewEnabledForDevState(
    useDevStore.getState().timeBillingPreview,
  );

export const useTimeBillingPreviewEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.timeBillingPreview);
  return isTimeBillingPreviewEnabledForDevState(devPreviewEnabled);
};

// Route-level gate: dev + env/host availability plus the per-browser preview
// toggle, so a direct load of a time-billing route (invoices, timesheets,
// expenses) resolves the same on server and client. Mirrors the playbooks and
// public-law route gates; the per-browser toggle is layered in because these
// routes are protected client-only surfaces with no server render to diverge.
export const isTimeBillingRouteEnabled = (): boolean =>
  import.meta.env.DEV ||
  env.VITE_FEATURE_TIME_BILLING ||
  isTimeBillingPreviewEnabled();
