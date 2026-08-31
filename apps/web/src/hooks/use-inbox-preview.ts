import { env } from "@/env";
import {
  betaFeaturesAvailable,
  betaFeaturesHostDefaultEnabled,
} from "@/lib/beta-features";
import { previewRouteAvailable } from "@/lib/beta-features.logic";
import { useDevStore } from "@/lib/dev-store";

const isInboxPreviewEnabledForDevState = (
  devPreviewEnabled: boolean,
): boolean =>
  env.VITE_FEATURE_INBOX || (betaFeaturesAvailable() && devPreviewEnabled);

export const isInboxPreviewEnabled = (): boolean =>
  isInboxPreviewEnabledForDevState(useDevStore.getState().inboxPreview);

export const useInboxPreviewEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.inboxPreview);
  return isInboxPreviewEnabledForDevState(devPreviewEnabled);
};

// The isomorphic half of the gate, for server-rendered chrome: the
// localStorage-backed toggle is browser-only and would mismatch hydration.
export const inboxSsrEntryEnabled = (): boolean =>
  env.VITE_FEATURE_INBOX || betaFeaturesHostDefaultEnabled();

// Deployment-enabled and beta-host routes resolve during SSR. Elsewhere, only
// an opted-in browser may navigate to the preview route.
export const inboxRouteAvailable = (): boolean =>
  previewRouteAvailable({
    browserPreviewEnabled: isInboxPreviewEnabled(),
    deploymentEnabled: env.VITE_FEATURE_INBOX,
    hostDefaultEnabled: betaFeaturesHostDefaultEnabled(),
  });
