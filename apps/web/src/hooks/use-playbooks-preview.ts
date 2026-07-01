import { env } from "@/env";
import { betaFeaturesAvailable } from "@/lib/beta-features";
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

// Route-level gate: env/host availability only, without the per-browser toggle,
// so `/knowledge/playbooks` resolves identically on server and client. The
// entry-point card and run action layer the toggle on top for the in-app UX.
export const playbooksRouteAvailable = (): boolean =>
  env.VITE_PLAYBOOKS_ENABLED || betaFeaturesAvailable();
