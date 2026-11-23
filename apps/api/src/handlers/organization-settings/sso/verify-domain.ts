import { Result } from "better-result";
import * as v from "valibot";

import { readOrgSsoDomain, recordOrgSsoDomainCheck } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { verifyDomainTxtRecord } from "@/api/lib/auth/sso-domain-verify";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { mapSsoDomainDnsError, mapSsoManagementError } from "./sso-error-map";

const paramsSchema = v.strictObject({
  domainId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
});

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  params: paramsSchema,
} satisfies HandlerConfig;

const verifyOrganizationSsoDomain = createSafeRootHandler(
  config,
  async function* ({ session, params, recordAuditEvent }) {
    const existing = await readOrgSsoDomain({
      organizationId: session.activeOrganizationId,
      domainId: params.domainId,
    });
    if (existing === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "domain_not_found",
          message: "Domain not found",
        }),
      );
    }

    const checkedAt = new Date();
    const verification = await verifyDomainTxtRecord({
      domain: existing.domain,
      expectedToken: existing.verificationToken,
    });
    if (verification.isErr()) {
      return Result.err(mapSsoDomainDnsError(verification.error));
    }

    const verified = verification.value.status === "verified";
    const recorded = await recordOrgSsoDomainCheck({
      organizationId: session.activeOrganizationId,
      domainId: existing.id,
      verified,
      checkedAt,
    });
    if (recorded.isErr()) {
      return Result.err(mapSsoManagementError(recorded.error));
    }

    if (verified) {
      yield* recordAuditEvent({
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
        resourceId: recorded.value.id,
        details: {
          setting: "sso_domain",
          domain: recorded.value.domain,
          status: "verified",
        },
      });
    }

    return Result.ok({
      domain: recorded.value,
      verified,
    });
  },
);

export default verifyOrganizationSsoDomain;
