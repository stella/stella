import { env } from "@/env";
import {
  betaFeaturesAvailable,
  betaFeaturesHostDefaultEnabled,
} from "@/lib/beta-features";
import { previewRouteAvailable } from "@/lib/beta-features.logic";
import { useDevStore } from "@/lib/dev-store";

const isWorkflowsPreviewEnabledForDevState = (
  devPreviewEnabled: boolean,
): boolean =>
  env.VITE_WORKFLOWS_ENABLED || (betaFeaturesAvailable() && devPreviewEnabled);

export const isWorkflowsPreviewEnabled = (): boolean =>
  isWorkflowsPreviewEnabledForDevState(useDevStore.getState().workflowsPreview);

export const useWorkflowsPreviewEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.workflowsPreview);
  return isWorkflowsPreviewEnabledForDevState(devPreviewEnabled);
};

// Deployment-enabled and beta-host routes resolve during SSR. Elsewhere, only
// an opted-in browser may navigate to the preview route.
export const workflowsRouteAvailable = (): boolean =>
  previewRouteAvailable({
    browserPreviewEnabled: isWorkflowsPreviewEnabled(),
    deploymentEnabled: env.VITE_WORKFLOWS_ENABLED,
    hostDefaultEnabled: betaFeaturesHostDefaultEnabled(),
  });
