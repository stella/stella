import { env } from "@/env";

export const isPublicLawRouteEnabled = (): boolean =>
  import.meta.env.DEV || env.VITE_PUBLIC_LAW_ENABLED;

export const isPublicLawIndexingEnabled = (): boolean =>
  env.VITE_PUBLIC_LAW_ENABLED && env.VITE_PUBLIC_LAW_INDEXING_ENABLED;
