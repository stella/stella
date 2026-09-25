import { env } from "@/env";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { useDevStore } from "@/lib/dev-store";

// AVT verifies documents against a legal list's facts, so it needs the lists
// deployment feature as well as the per-browser beta opt-in.
const isAvtPreviewEnabledForDevState = (devPreviewEnabled: boolean): boolean =>
  env.VITE_FEATURE_LEGAL_LISTS && betaFeaturesAvailable() && devPreviewEnabled;

export const isAvtPreviewEnabled = (): boolean =>
  isAvtPreviewEnabledForDevState(useDevStore.getState().avtPreview);

export const useAvtPreviewEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.avtPreview);
  return isAvtPreviewEnabledForDevState(devPreviewEnabled);
};
