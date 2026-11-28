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
  aggregateMutation: {
    type: "independent",
    reason: "Read-only OIDC discovery probe with no persisted mutation.",
  },
} satisfies HandlerConfig;

const testOrganizationSsoProviderHandler = createSafeRootHandler(
  config,
  async function* ({ body }) {
    const value = yield* Result.await(
      probeOidcDiscovery({
        issuer: body.issuer,
        ...(body.discoveryEndpoint !== undefined
          ? { discoveryEndpoint: body.discoveryEndpoint }
          : {}),
        permit: grantThirdPartyOutboundPermit(),
      }).then((result) => result.mapError(mapOidcDiscoveryError)),
    );
    return Result.ok(value);
  },
);

export default testOrganizationSsoProviderHandler;
