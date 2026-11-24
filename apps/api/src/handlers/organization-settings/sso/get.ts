import { Result } from "better-result";

import { readOrgSsoSettings } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { ssoProviderUrls } from "./sso-urls";

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;

const readOrganizationSsoHandler = createSafeRootHandler(
  config,
  async function* ({ session }) {
    const settings = await readOrgSsoSettings(
      session.activeOrganizationId,
      ssoProviderUrls,
    );
    return Result.ok(yield* Result.ok(settings));
  },
);

export default readOrganizationSsoHandler;
