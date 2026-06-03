import { env } from "@/env";
import { useDevStore } from "@/lib/dev-store";

export const usePublicLawPreviewEnabled = (): boolean => {
  const devPreviewEnabled = useDevStore((s) => s.publicLawPreview);

  return (
    env.VITE_PUBLIC_LAW_ENABLED || (import.meta.env.DEV && devPreviewEnabled)
  );
};
