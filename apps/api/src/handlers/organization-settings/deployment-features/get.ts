import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";

const config = {
  description:
    "Report which deployment features this server serves, so the web client offers only those.",
  // Any org member may read these deployment-wide switches; they carry no
  // organization data.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
} satisfies HandlerConfig;

/** The deployment features the web asks about, read from their flags. */
export const readDeploymentFeatures = () => ({
  timeBilling: isDeploymentFeatureEnabled("FEATURE_TIME_BILLING"),
});

export default createSafeRootHandler(
  config,
  // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
  async function* () {
    return Result.ok(readDeploymentFeatures());
  },
);
