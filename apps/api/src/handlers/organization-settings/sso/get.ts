import { Result } from "better-result";

import { readOrgSsoSettings } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { listOrganizationScimTokens } from "@/api/lib/auth/scim-management";

import { mapScimManagementError } from "./sso-error-map";
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
    const [settings, scimTokens] = await Promise.all([
      readOrgSsoSettings(session.activeOrganizationId, ssoProviderUrls),
      listOrganizationScimTokens(session.activeOrganizationId),
    ]);
    if (scimTokens.isErr()) {
      return Result.err(mapScimManagementError(scimTokens.error));
    }
    return Result.ok(
      yield* Result.ok({
        ...settings,
        scimTokens: scimTokens.value,
      }),
    );
  },
);

export default readOrganizationSsoHandler;
