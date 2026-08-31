import { env } from "@/env";
import { useHasMounted } from "@/hooks/use-chrome-query";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { publicShellPreviewEntryVisible } from "@/lib/beta-features.logic";
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

// The Inbox entry in the server-rendered public shell (/law, /tools), which
// unlike the app sidebar renders for signed-out visitors too.
export const usePublicShellInboxEntryEnabled = (): boolean => {
  const browserPreviewEnabled = useInboxPreviewEnabled();
  const mounted = useHasMounted();
  return publicShellPreviewEntryVisible({
    browserPreviewEnabled,
    deploymentEnabled: env.VITE_FEATURE_INBOX,
    mounted,
  });
};
