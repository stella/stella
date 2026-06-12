import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHost } from "@tanstack/react-start/server";

// Hosts where users may flip beta features themselves (Settings →
// Beta features). Production is deliberately excluded: launches there
// go through real feature flags, not per-browser toggles.
const BETA_FEATURES_HOSTS = new Set(["staging.stll.app"]);

// /law paths are selectively server-rendered, so availability must
// resolve identically on the server (request Host header) and the
// client (location), or direct loads would 404 on beta hosts.
const requestHostname = createIsomorphicFn()
  .server((): string | null => getRequestHost().split(":")[0] ?? null)
  .client((): string | null => window.location.hostname);

export const betaFeaturesAvailable = (): boolean =>
  import.meta.env.DEV || BETA_FEATURES_HOSTS.has(requestHostname() ?? "");
