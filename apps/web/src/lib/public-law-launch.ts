import { env } from "@/env";
import { isPublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";

// Includes the beta-features preview state so hosts where users can
// flip the toggle (dev, staging) also serve the /law routes; without
// it the sidebar entry would lead to a 404.
export const isPublicLawRouteEnabled = (): boolean =>
  import.meta.env.DEV || isPublicLawPreviewEnabled();

export const isPublicLawIndexingEnabled = (): boolean =>
  env.VITE_PUBLIC_LAW_ENABLED && env.VITE_PUBLIC_LAW_INDEXING_ENABLED;
