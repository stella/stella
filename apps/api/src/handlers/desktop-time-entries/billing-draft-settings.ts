import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { DesktopBillingDraftSettingsRequest } from "@stll/api-contract/desktop-billing-drafts";
import {
  desktopBillingDraftSettingsRequestSchema,
  desktopBillingDraftSettingsResponseSchema,
  desktopBillingDraftSettingsUpdateResponseSchema,
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
import {
  isTimestampCasToken,
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { projectionPayload } from "@/api/lib/projection-totality";

import { authorizeDesktopTimeEntries } from "./authorize";

const ownSettingsColumns = {
  revision: timestampCasToken(billingDraftUserSettings.updatedAt),
  consentAt: billingDraftUserSettings.consentAt,
  preference: billingDraftUserSettings.preference,
};

// Every write moves the revision forward, also twice within one microsecond.
const nextRevision = sql`greatest(clock_timestamp(), ${billingDraftUserSettings.updatedAt} + interval '1 microsecond')`;

const AUDITED_CHANGE = {
  withdraw_consent: { consent: "revoked", preferenceChanged: false },
  grant_consent: { consent: "granted", preferenceChanged: false },
  set_preference: { preferenceChanged: true },
} as const satisfies Record<
  DesktopBillingDraftSettingsRequest["type"],
  { consent?: "granted" | "revoked"; preferenceChanged: boolean }
>;

type ConditionalSettingsChange = Exclude<
  DesktopBillingDraftSettingsRequest,
  { type: "withdraw_consent" }
>;

const conditionalPatch = (change: ConditionalSettingsChange) => {
  switch (change.type) {
    case "grant_consent":
      return { consentAt: new Date() };
    case "set_preference":
      return { preference: change.preference };
    default:
      return panic(
        "Unknown billing draft settings change",
        change satisfies never,
      );
  }
};

type WriteOwnBillingDraftSettingsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  change: DesktopBillingDraftSettingsRequest;
  recordAuditEvent: ReturnType<typeof createAuditRecorder>;
};

/**
 * Writes the caller's own settings row. A consent withdrawal always applies,
 * whatever was written since the caller last read, and creates the row when
 * none exists. A grant or a preference change applies only while its
 * `revision` still names the stored row (`null`: no row yet) and otherwise
 * returns `undefined` without writing.
 */
export const writeOwnBillingDraftSettings = async ({
  tx,
  organizationId,
  userId,
  change,
  recordAuditEvent,
}: WriteOwnBillingDraftSettingsOptions) => {
  const ownRow = and(
    eq(billingDraftUserSettings.organizationId, organizationId),
    eq(billingDraftUserSettings.userId, userId),
  );
  let rows: {
    revision: string;
    consentAt: Date | null;
    preference: string | null;
  }[];
  if (change.type === "withdraw_consent") {
    rows = await tx
      .insert(billingDraftUserSettings)
      .values({ organizationId, userId, consentAt: null })
      .onConflictDoUpdate({
        target: [
          billingDraftUserSettings.organizationId,
          billingDraftUserSettings.userId,
        ],
        set: { consentAt: null, updatedAt: nextRevision },
      })
      .returning(ownSettingsColumns);
    if (rows.length === 0) {
      return panic("Billing draft consent withdrawal returned no row");
    }
  } else if (change.revision === null) {
    rows = await tx
      .insert(billingDraftUserSettings)
      .values({ organizationId, userId, ...conditionalPatch(change) })
      .onConflictDoNothing()
      .returning(ownSettingsColumns);
  } else if (isTimestampCasToken(change.revision)) {
    rows = await tx
      .update(billingDraftUserSettings)
      .set({ ...conditionalPatch(change), updatedAt: nextRevision })
      .where(
        and(
          ownRow,
          timestampMatchesCasToken(
            billingDraftUserSettings.updatedAt,
            change.revision,
          ),
        ),
      )
      .returning(ownSettingsColumns);
  } else {
    // Not a revision this column ever produced, so it names no stored row.
    rows = [];
  }
  const own = rows.at(0);
  if (own === undefined) {
    return undefined;
  }
  // Audit the action without storing private drafting instructions in logs.
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: userId,
    metadata: {
      settings: "personal-billing-drafts",
      ...AUDITED_CHANGE[change.type],
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
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopBillingDraftSettingsResponseSchema,
      ),
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
            .select(ownSettingsColumns)
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
        response: safePublicHandlerResponseSchemasWithStatusText(
          desktopBillingDraftSettingsUpdateResponseSchema,
        ),
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
            const own = await writeOwnBillingDraftSettings({
              tx,
              organizationId: account.organizationId,
              userId: account.userId,
              change: body,
              recordAuditEvent,
            });
            if (own === undefined) {
              return undefined;
            }
            const org = await tx
              .select({ mode: organizationSettings.aiBillingDraftsMode })
              .from(organizationSettings)
              .where(
                eq(organizationSettings.organizationId, account.organizationId),
              )
              .limit(1);
            return {
              revision: own.revision,
              organizationMode: org.at(0)?.mode ?? "disabled",
              consent: own.consentAt
                ? ("granted" as const)
                : ("revoked" as const),
              preference: own.preference,
            };
          }),
        );
        if (settings === undefined) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "Billing draft settings changed; reload before retrying",
            }),
          );
        }
        return Result.ok(
          projectionPayload(
            desktopBillingDraftSettingsUpdateResponseSchema,
            settings,
          ),
        );
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
