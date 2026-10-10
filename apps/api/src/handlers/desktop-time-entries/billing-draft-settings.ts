import { Type } from "@sinclair/typebox";
import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import {
  desktopBillingDraftSettingsRequestSchema,
  desktopBillingDraftSettingsResponseSchema,
} from "@stll/api-contract/desktop-billing-drafts";
import type { DesktopBillingDraftSettingsResponse } from "@stll/api-contract/desktop-billing-drafts";

import {
  billingDraftUserSettings,
  organizationSettings,
} from "@/api/db/schema";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { jsonSchemaToTypeBox } from "@/api/lib/json-schema/json-schema-to-typebox";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";

import { authorizeDesktopTimeEntries } from "./authorize";

const billingDraftSettingsResponseSchema =
  Type.Unsafe<DesktopBillingDraftSettingsResponse>(
    jsonSchemaToTypeBox(
      toJsonSchema(desktopBillingDraftSettingsResponseSchema),
    ),
  );

const settingsConfig = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    billingDraftSettingsResponseSchema,
  ),
} as const;

export const createDesktopBillingDraftSettingsEndpoints = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) => ({
  read: createSafeBoundedPublicHandler(
    settingsConfig,
    async function* ({ request }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      const settings = yield* Result.await(
        account.safeDb(async (tx) => {
          const org = await tx
            .select({ mode: organizationSettings.aiBillingDraftsMode })
            .from(organizationSettings)
            .where(
              eq(organizationSettings.organizationId, account.organizationId),
            )
            .limit(1);
          const own = await tx
            .select({
              consentAt: billingDraftUserSettings.consentAt,
              preference: billingDraftUserSettings.preference,
            })
            .from(billingDraftUserSettings)
            .where(eq(billingDraftUserSettings.userId, account.userId))
            .limit(1);
          return {
            organizationMode: org.at(0)?.mode ?? "disabled",
            consent: own.at(0)?.consentAt
              ? ("granted" as const)
              : ("revoked" as const),
            preference: own.at(0)?.preference ?? null,
          };
        }),
      );
      return Result.ok(settings);
    },
  ),
  update: createSafeBoundedPublicHandler(
    { ...settingsConfig, body: desktopBillingDraftSettingsRequestSchema },
    async function* ({ request, body }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      const recordAuditEvent = createAuditRecorder({
        organizationId: account.organizationId,
        userId: account.userId,
        workspaceId: null,
        request,
        server: null,
      });
      const settings = yield* Result.await(
        account.safeDb(async (tx) => {
          const patch = {
            ...(body.consent === undefined
              ? {}
              : { consentAt: body.consent === "granted" ? new Date() : null }),
            ...(body.preference === undefined
              ? {}
              : { preference: body.preference }),
            updatedAt: new Date(),
          };
          const rows = await tx
            .insert(billingDraftUserSettings)
            .values({ userId: account.userId, ...patch })
            .onConflictDoUpdate({
              target: billingDraftUserSettings.userId,
              set: patch,
            })
            .returning({
              consentAt: billingDraftUserSettings.consentAt,
              preference: billingDraftUserSettings.preference,
            });
          const own =
            rows.at(0) ??
            panic("Billing draft settings upsert returned no row");
          // Audit the action without storing private drafting instructions in logs.
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: account.userId,
            metadata: {
              settings: "personal-billing-drafts",
              consent: body.consent,
              preferenceChanged: body.preference !== undefined,
            },
          });
          const org = await tx
            .select({ mode: organizationSettings.aiBillingDraftsMode })
            .from(organizationSettings)
            .where(
              eq(organizationSettings.organizationId, account.organizationId),
            )
            .limit(1);
          return {
            organizationMode: org.at(0)?.mode ?? "disabled",
            consent: own.consentAt
              ? ("granted" as const)
              : ("revoked" as const),
            preference: own.preference,
          };
        }),
      );
      return Result.ok(settings);
    },
  ),
});

export default createDesktopBillingDraftSettingsEndpoints();
