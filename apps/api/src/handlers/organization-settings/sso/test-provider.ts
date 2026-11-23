import { Result } from "better-result";

import { testOidcSsoProviderBodySchema } from "@stll/api-contract/sso";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { probeOidcDiscovery } from "@/api/lib/auth/sso-discovery";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

import { mapOidcDiscoveryError } from "./sso-error-map";

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: testOidcSsoProviderBodySchema,
} satisfies HandlerConfig;

const testOrganizationSsoProvider = createSafeRootHandler(
  config,
  async ({ body }) => {
    const probed = await probeOidcDiscovery({
      issuer: body.issuer,
      discoveryEndpoint: body.discoveryEndpoint,
      permit: grantThirdPartyOutboundPermit(),
    });
    if (probed.isErr()) {
      return Result.err(mapOidcDiscoveryError(probed.error));
    }
    return Result.ok(probed.value);
  },
);

export default testOrganizationSsoProvider;
