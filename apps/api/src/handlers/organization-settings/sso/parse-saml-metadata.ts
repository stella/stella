import { Result } from "better-result";

import { parseSamlMetadataBodySchema } from "@stll/api-contract/sso";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resolveSamlIdpMetadata } from "@/api/lib/auth/saml-metadata";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

import { mapSamlMetadataError } from "./sso-error-map";

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: parseSamlMetadataBodySchema,
} satisfies HandlerConfig;

const parseOrganizationSamlMetadataHandler = createSafeRootHandler(
  config,
  async function* ({ body }) {
    const value = yield* Result.await(
      resolveSamlIdpMetadata({
        input: body,
        permit: grantThirdPartyOutboundPermit(),
      }).then((result) => result.mapError(mapSamlMetadataError)),
    );
    return Result.ok(value);
  },
);

declareAggregateMutation(parseOrganizationSamlMetadataHandler, {
  type: "independent",
  reason:
    "Read-only SAML metadata parser and fetch with no persisted mutation.",
});

export default parseOrganizationSamlMetadataHandler;
