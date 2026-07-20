import { env } from "@/env";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { useDevStore } from "@/lib/dev-store";

const isWorkflowsPreviewEnabledForDevState = (
  devPreviewEnabled: boolean,
): boolean =>
  env.VITE_WORKFLOWS_ENABLED || (betaFeaturesAvailable() && devPreviewEnabled);

export const useWorkflowsPreviewEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.workflowsPreview);
  return isWorkflowsPreviewEnabledForDevState(devPreviewEnabled);
};

// Route-level gate: env/host availability only, without the per-browser toggle,
// so the workflows routes resolve identically on server and client. The
// entry-point cards layer the toggle on top for the in-app UX.
export const workflowsRouteAvailable = (): boolean =>
  env.VITE_WORKFLOWS_ENABLED || betaFeaturesAvailable();
