import { env } from "@/env";
import { useDevStore } from "@/lib/dev-store";

const isPublicLawPreviewEnabledForDevState = (
  devPreviewEnabled: boolean,
): boolean =>
  env.VITE_PUBLIC_LAW_ENABLED || (import.meta.env.DEV && devPreviewEnabled);

export const isPublicLawPreviewEnabled = (): boolean =>
  isPublicLawPreviewEnabledForDevState(useDevStore.getState().publicLawPreview);

export const usePublicLawPreviewEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.publicLawPreview);
  return isPublicLawPreviewEnabledForDevState(devPreviewEnabled);
};
