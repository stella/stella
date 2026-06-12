// Hosts where users may flip beta features themselves (Settings →
// Beta features). Production is deliberately excluded: launches there
// go through real feature flags, not per-browser toggles.
const BETA_FEATURES_HOSTS = new Set(["staging.stll.app"]);

export const betaFeaturesAvailable = (): boolean =>
  import.meta.env.DEV ||
  (typeof window !== "undefined" &&
    BETA_FEATURES_HOSTS.has(window.location.hostname));
