import type { WebApiRoutes } from "@/lib/eden-client";

export const DISABLED_NAVIGATION_FEATURES = {
  timeBilling: false,
  signals: false,
  flows: false,
} satisfies WebApiRoutes["workspaces"]["navigation"]["get"]["response"][200]["features"];
