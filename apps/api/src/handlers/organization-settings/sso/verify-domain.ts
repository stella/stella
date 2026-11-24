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

const verifyOrganizationSsoDomainHandler = createSafeRootHandler(
  config,
  async function* ({ session, params, safeDb, recordAuditEvent }) {
    const record = await readOrgSsoDomain({
      organizationId: session.activeOrganizationId,
      domainId: params.domainId,
    });
    if (record === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "domain_not_found",
          message: "Domain not found",
        }),
      );
    }

    const dnsResult = await verifyDomainTxtRecord({
      domain: record.domain,
      expectedToken: record.verificationToken,
    });
    if (dnsResult.isErr()) {
      return Result.err(mapSsoDomainDnsError(dnsResult.error));
    }

    const verified = dnsResult.value.status === "verified";
    const updated = await recordOrgSsoDomainCheck({
      organizationId: session.activeOrganizationId,
      domainId: record.id,
      verified,
      checkedAt: new Date(),
    });
    if (updated.isErr()) {
      return Result.err(mapSsoManagementError(updated.error));
    }

    if (verified) {
      yield* Result.await(
        safeDb(async (tx) => {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: updated.value.id,
            metadata: {
              setting: "sso_domain",
              domain: updated.value.domain,
              status: "verified",
            },
          });
        }),
      );
    }

    return Result.ok({ domain: updated.value, verified });
  },
);

export default verifyOrganizationSsoDomainHandler;
