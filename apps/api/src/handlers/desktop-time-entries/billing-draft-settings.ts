import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  desktopBillingDraftSettingsRequestSchema,
  desktopBillingDraftSettingsResponseSchema,
} from "@stll/api-contract/desktop-billing-drafts";

import type { Transaction } from "@/api/db/root";
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
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { projectionPayload } from "@/api/lib/projection-totality";

import { authorizeDesktopTimeEntries } from "./authorize";

const settingsResponse = safePublicHandlerResponseSchemasWithStatusText(
  desktopBillingDraftSettingsResponseSchema,
);

const updateResponseSchema = v.strictObject({
  ...desktopBillingDraftSettingsResponseSchema.entries,
  revision: desktopBillingDraftSettingsResponseSchema.entries.revision.wrapped,
});

type WriteBillingDraftUserSettingsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: v.InferOutput<typeof desktopBillingDraftSettingsRequestSchema>;
  recordAuditEvent: ReturnType<typeof createAuditRecorder>;
};

/** A stale request never changes either consent or preferences, including first-write races. */
export const writeBillingDraftUserSettings = async ({
  tx,
  organizationId,
  userId,
  body,
  recordAuditEvent,
}: WriteBillingDraftUserSettingsOptions) => {
  const patch = {
    ...(body.consent === undefined
      ? {}
      : { consentAt: body.consent === "granted" ? new Date() : null }),
    ...(body.preference === undefined ? {} : { preference: body.preference }),
  };
  const returning = {
    consentAt: billingDraftUserSettings.consentAt,
    preference: billingDraftUserSettings.preference,
    revision: timestampCasToken(billingDraftUserSettings.updatedAt).mapWith(
      String,
    ),
  };
  const rows =
    body.revision === null
      ? await tx
          .insert(billingDraftUserSettings)
          .values({ organizationId, userId, ...patch })
          .onConflictDoNothing()
          .returning(returning)
      : await tx
          .update(billingDraftUserSettings)
          .set({
            ...patch,
            updatedAt: sql`greatest(clock_timestamp(), ${billingDraftUserSettings.updatedAt} + interval '1 microsecond')`,
          })
          .where(
            and(
              eq(billingDraftUserSettings.organizationId, organizationId),
              eq(billingDraftUserSettings.userId, userId),
              sql`${billingDraftUserSettings.updatedAt}::text = ${body.revision}`,
            ),
          )
          .returning(returning);
  const own = rows.at(0);
  if (!own) {
    return undefined;
  }
  // Audit the action without storing private drafting instructions in logs.
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: userId,
    metadata: {
      settings: "personal-billing-drafts",
      consent: body.consent,
      preferenceChanged: body.preference !== undefined,
    },
  });
  return own;
};

export const createDesktopBillingDraftSettingsReadEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      response: settingsResponse,
    },
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
              revision: timestampCasToken(
                billingDraftUserSettings.updatedAt,
              ).mapWith(String),
              consentAt: billingDraftUserSettings.consentAt,
              preference: billingDraftUserSettings.preference,
            })
            .from(billingDraftUserSettings)
            .where(
              and(
                eq(
                  billingDraftUserSettings.organizationId,
                  account.organizationId,
                ),
                eq(billingDraftUserSettings.userId, account.userId),
              ),
            )
            .limit(1);
          return {
            scopeKey: JSON.stringify([account.organizationId, account.userId]),
            revision: own.at(0)?.revision ?? null,
            organizationMode: org.at(0)?.mode ?? "disabled",
            consent: own.at(0)?.consentAt
              ? ("granted" as const)
              : ("revoked" as const),
            preference: own.at(0)?.preference ?? null,
          };
        }),
      );
      return Result.ok(
        projectionPayload(desktopBillingDraftSettingsResponseSchema, settings),
      );
    },
  );

export const createDesktopBillingDraftSettingsUpdateEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  declareAggregateMutation(
    createSafeBoundedPublicHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "auth_plumbing" },
        cache: { kind: "none" },
        body: desktopBillingDraftSettingsRequestSchema,
        response:
          safePublicHandlerResponseSchemasWithStatusText(updateResponseSchema),
      },
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
            const own = await writeBillingDraftUserSettings({
              tx,
              organizationId: account.organizationId,
              userId: account.userId,
              body,
              recordAuditEvent,
            });
            if (!own) {
              return null;
            }
            const org = await tx
              .select({ mode: organizationSettings.aiBillingDraftsMode })
              .from(organizationSettings)
              .where(
                eq(organizationSettings.organizationId, account.organizationId),
              )
              .limit(1);
            return {
              scopeKey: JSON.stringify([
                account.organizationId,
                account.userId,
              ]),
              revision: own.revision,
              organizationMode: org.at(0)?.mode ?? "disabled",
              consent: own.consentAt
                ? ("granted" as const)
                : ("revoked" as const),
              preference: own.preference,
            };
          }),
        );
        if (settings === null) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "Billing draft settings changed; reload before retrying",
            }),
          );
        }
        return Result.ok(projectionPayload(updateResponseSchema, settings));
      },
    ),
    {
      type: "independent",
      reason:
        "Updates only the authenticated person's consent and preference through the organization/user primary-key upsert; no shared aggregate state is mutated.",
    },
  );

export const readBillingDraftSettings =
  createDesktopBillingDraftSettingsReadEndpoint();
export const updateBillingDraftSettings =
  createDesktopBillingDraftSettingsUpdateEndpoint();
