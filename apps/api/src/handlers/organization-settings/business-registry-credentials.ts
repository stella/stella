import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import {
  BUSINESS_REGISTRY_CREDENTIAL_SLUGS,
  BUSINESS_REGISTRY_SLUGS,
} from "@stll/api-contract";
import type { BusinessRegistryCredentialSlug } from "@stll/api-contract";

import { businessRegistryCredentials } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  bindRegistryCredential,
  encryptRegistryCredential,
  registryConfigurationStatus,
} from "@/api/lib/business-registries/credentials";
import {
  BUSINESS_REGISTRY_DISPATCH,
  executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
} from "@/api/lib/usage/action-costs/context";

const credentialRegistrySchema = t.UnionEnum(
  BUSINESS_REGISTRY_CREDENTIAL_SLUGS,
);

export const readBusinessRegistryCredentials = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    access: "read",
    mcp: { type: "internal", reason: "provider_secret" },
  },
  async function* ({ safeDb, session }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx.query.businessRegistryCredentials.findMany({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: { registry: true },
          limit: BUSINESS_REGISTRY_CREDENTIAL_SLUGS.length,
        }),
      ),
    );
    return Result.ok({
      registries: BUSINESS_REGISTRY_SLUGS.map((registry) =>
        registryConfigurationStatus(
          registry,
          rows.some((row) => row.registry === registry),
        ),
      ),
    });
  },
);

// Public canonical records probe authentication without a broad name search.
const CREDENTIAL_PROBE_QUERIES = {
  "companies-house": "00445790",
  denue: "restaurante",
  edgar: "320193",
} as const satisfies Record<BusinessRegistryCredentialSlug, string>;

export const saveBusinessRegistryCredential = createSafeRootHandler(
  {
    permissions: { organizationSettings: ["update"] },
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "provider_secret" },
    body: t.Object(
      {
        registry: credentialRegistrySchema,
        credential: t.String({ minLength: 1, maxLength: 512 }),
      },
      { additionalProperties: false },
    ),
  },
  async function* ({ body, safeDb, session, recordAuditEvent }) {
    const observer = actionRequestObserver(
      session.activeOrganizationId,
      ACTION_COST_CALL_KIND.registryRequest,
    );
    const credential = body.credential.trim();
    if (!credential || /[\r\n]/u.test(credential)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Enter a valid registry credential",
        }),
      );
    }
    if (
      body.registry === "edgar" &&
      !credential
        .split(/\s+/u)
        .some((part) => v.is(v.pipe(v.string(), v.email()), part))
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "SEC identification must include a contact email address",
        }),
      );
    }
    const encrypted = yield* Result.await(
      encryptRegistryCredential(session.activeOrganizationId, credential),
    );
    const probe = await executeRegistryLookup({
      observer,
      permit: grantThirdPartyOutboundPermit(),
      handler: bindRegistryCredential(
        BUSINESS_REGISTRY_DISPATCH[body.registry],
        credential,
      ),
      query: CREDENTIAL_PROBE_QUERIES[body.registry],
      limit: 1,
    });
    if (HandlerError.is(probe)) {
      return Result.err(probe);
    }
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .insert(businessRegistryCredentials)
          .values({
            organizationId: session.activeOrganizationId,
            registry: body.registry,
            ...encrypted,
          })
          .onConflictDoUpdate({
            target: [
              businessRegistryCredentials.organizationId,
              businessRegistryCredentials.registry,
            ],
            set: { ...encrypted, updatedAt: new Date() },
          });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            field: "businessRegistryCredential",
            registry: body.registry,
            change: "set",
          },
        });
      }),
    );
    return Result.ok({ success: true });
  },
);

export const deleteBusinessRegistryCredential = createSafeRootHandler(
  {
    permissions: { organizationSettings: ["update"] },
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "provider_secret" },
    query: t.Object({ registry: credentialRegistrySchema }),
  },
  async function* ({ query, safeDb, session, recordAuditEvent }) {
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .delete(businessRegistryCredentials)
          .where(
            and(
              eq(
                businessRegistryCredentials.organizationId,
                session.activeOrganizationId,
              ),
              eq(businessRegistryCredentials.registry, query.registry),
            ),
          );
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            field: "businessRegistryCredential",
            registry: query.registry,
            change: "removed",
          },
        });
      }),
    );
    return Result.ok({ success: true });
  },
);
