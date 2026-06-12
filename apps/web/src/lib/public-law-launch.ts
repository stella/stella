import { env } from "@/env";
import { betaFeaturesAvailable } from "@/lib/beta-features";

// Beta hosts always serve the /law routes; the Settings toggle only
// governs discoverability (sidebar entry, search kinds). The gate must
// not depend on the localStorage-backed toggle because /law paths are
// server-rendered and the server cannot see it — host and env flag
// resolve identically on both sides.
export const isPublicLawRouteEnabled = (): boolean =>
  import.meta.env.DEV || env.VITE_PUBLIC_LAW_ENABLED || betaFeaturesAvailable();

export const isPublicLawIndexingEnabled = (): boolean =>
  env.VITE_PUBLIC_LAW_ENABLED && env.VITE_PUBLIC_LAW_INDEXING_ENABLED;
