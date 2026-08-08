import { env } from "@/env";
import {
  betaFeaturesAvailable,
  betaFeaturesHostDefaultEnabled,
} from "@/lib/beta-features";
import { previewRouteAvailable } from "@/lib/beta-features.logic";
import { useDevStore } from "@/lib/dev-store";

const isPlaybooksPreviewEnabledForDevState = (
  devPreviewEnabled: boolean,
): boolean =>
  env.VITE_PLAYBOOKS_ENABLED || (betaFeaturesAvailable() && devPreviewEnabled);

export const isPlaybooksPreviewEnabled = (): boolean =>
  isPlaybooksPreviewEnabledForDevState(useDevStore.getState().playbooksPreview);

export const usePlaybooksPreviewEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.playbooksPreview);
  return isPlaybooksPreviewEnabledForDevState(devPreviewEnabled);
};

// Deployment-enabled and beta-host routes resolve during SSR. Elsewhere, only
// an opted-in browser may navigate to the preview route.
export const playbooksRouteAvailable = (): boolean =>
  previewRouteAvailable({
    browserPreviewEnabled: isPlaybooksPreviewEnabled(),
    deploymentEnabled: env.VITE_PLAYBOOKS_ENABLED,
    hostDefaultEnabled: betaFeaturesHostDefaultEnabled(),
  });
