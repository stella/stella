import { env } from "@/env";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { useDevStore } from "@/lib/dev-store";

const isGuidesPreviewEnabledForDevState = (
  devPreviewEnabled: boolean,
): boolean =>
  env.VITE_GUIDES_ENABLED || (betaFeaturesAvailable() && devPreviewEnabled);

// In-app gate for the Help & guides entry: env flag (prod launch path) OR beta
// host (dev/staging) with the per-browser toggle on. Dark in production by
// default, mirroring the workflows preview.
export const useGuidesPreviewEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.guidesPreview);
  return isGuidesPreviewEnabledForDevState(devPreviewEnabled);
};
