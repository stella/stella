import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHost } from "@tanstack/react-start/server";

import { env } from "@/env";

// Hosts where users may flip beta features themselves without an explicit
// deployment opt-in. Production images expose the page through the build-time
// VITE_BETA_FEATURES_ENABLED switch; individual previews remain off.
const BETA_FEATURES_HOSTS = Object.freeze(["staging.stll.app"]);

// /law paths are selectively server-rendered, so availability must
// resolve identically on the server (request Host header) and the
// client (location), or direct loads would 404 on beta hosts.
const requestHostname = createIsomorphicFn()
  .server((): string | null => getRequestHost().split(":")[0] ?? null)
  .client((): string | null => window.location.hostname);

export const betaFeaturesHostDefaultEnabled = (): boolean =>
  import.meta.env.DEV || BETA_FEATURES_HOSTS.includes(requestHostname() ?? "");

export const betaFeaturesAvailable = (): boolean =>
  env.VITE_BETA_FEATURES_ENABLED || betaFeaturesHostDefaultEnabled();
