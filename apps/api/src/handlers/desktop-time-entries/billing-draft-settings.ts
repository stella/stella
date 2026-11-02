import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import type { DesktopBillingDraftSettingsRequest } from "@stll/api-contract/desktop-billing-drafts";
import {
  desktopBillingDraftSettingsRequestSchema,
  desktopBillingDraftSettingsResponseSchema,
  desktopBillingDraftSettingsUpdateResponseSchema,
  desktopBillingDraftWithdrawalSchema,
} from "@stll/api-contract/desktop-billing-drafts";

import type { Transaction } from "@/api/db/root";
import { billingDraftUserSettings } from "@/api/db/schema";
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
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import {
  isTimestampCasToken,
  timestampCasToken,
  timestampCasTokenText,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import type { DeploymentFeatureException } from "@/api/lib/deployment-feature-route";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { projectionPayload } from "@/api/lib/projection-totality";

import {
  authorizeDesktopCaller,
  authorizeDesktopTimeEntries,
} from "./authorize";
import {
  readEffectiveDraftMode,
  readOrganizationDraftsMode,
} from "./billing-draft-mode";

const ownSettingsColumns = {
  revision: timestampCasToken(billingDraftUserSettings.updatedAt),
  consentAt: billingDraftUserSettings.consentAt,
  preference: billingDraftUserSettings.preference,
};

type OwnSettings = {
  revision: TimestampCasToken;
  consentAt: Date | null;
  preference: string | null;
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
  let rows: OwnSettings[];
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

type SettingsViewOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  /** Whether draft time entries are available to the caller at all. */
  timeEntriesAvailable: boolean;
  own: Pick<OwnSettings, "consentAt" | "preference">;
};

/** The caller's settings as the desktop shows them, with the drafting the
 * caller gets: `off` while the organization or the feature is off. */
export const readSettingsView = async ({
  tx,
  organizationId,
  timeEntriesAvailable,
  own,
}: SettingsViewOptions) => ({
  effectiveMode: timeEntriesAvailable
    ? await readEffectiveDraftMode({
        tx,
        organizationId,
        organizationMode: await readOrganizationDraftsMode({
          tx,
          organizationId,
        }),
      })
    : ("off" as const),
  consent: own.consentAt ? ("granted" as const) : ("revoked" as const),
  preference: own.preference,
});

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
          const own = (
            await tx
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
              .limit(1)
          ).at(0);
          return {
            revision:
              own === undefined ? null : timestampCasTokenText(own.revision),
            ...(await readSettingsView({
              tx,
              organizationId: account.organizationId,
              timeEntriesAvailable: true,
              own: own ?? { consentAt: null, preference: null },
            })),
          };
        }),
      );
      return Result.ok(
        projectionPayload(desktopBillingDraftSettingsResponseSchema, settings),
      );
    },
  );

/** The committed change's answer could not read the settings view back. */
const settingsViewReadFailed = failureSink({
  event: "billing_draft_settings.view_read_failed",
  expected: [],
});

type SettingsUpdateDependencies = {
  /** Test seam for the answer's second read. */
  readView?: typeof readSettingsView;
};

export const createDesktopBillingDraftSettingsUpdateEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
  { readView = readSettingsView }: SettingsUpdateDependencies = {},
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
        // A withdrawal needs only the linked account: whoever could consent
        // can always take it back, also once the feature or its deployment
        // is off. Every other change needs the feature.
        const account = yield* Result.await(
          authorizeDesktopCaller(request, authorizeAccount),
        );
        if (body.type !== "withdraw_consent" && !account.timeEntriesAvailable) {
          return Result.err(
            new HandlerError({
              status: 403,
              message: "Draft time entries are unavailable",
            }),
          );
        }
        const recordAuditEvent = createAuditRecorder({
          organizationId: account.organizationId,
          userId: account.userId,
          workspaceId: null,
          request,
          server: null,
        });
        // The write commits on its own: nothing read afterwards can undo a
        // withdrawal.
        const own = yield* Result.await(
          account.safeDb(
            async (tx) =>
              await writeOwnBillingDraftSettings({
                tx,
                organizationId: account.organizationId,
                userId: account.userId,
                change: body,
                recordAuditEvent,
              }),
          ),
        );
        if (own === undefined) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "Billing draft settings changed; reload before retrying",
            }),
          );
        }
        const view = await account.safeDb(
          async (tx) =>
            await readView({
              tx,
              organizationId: account.organizationId,
              timeEntriesAvailable: account.timeEntriesAvailable,
              own,
            }),
        );
        // The change is committed whatever this read does, so the answer
        // always names the committed row and its revision: a client retrying
        // with the old revision would only meet a 409. Without the view the
        // drafting the caller gets is unknown and answers `off` until the
        // next read names it.
        if (view.isErr()) {
          observeFailure(view.error, {
            sink: settingsViewReadFailed,
            ctx: { operation: body.type },
          });
        }
        const settings = view.isOk()
          ? view.value
          : {
              effectiveMode: "off" as const,
              consent: own.consentAt
                ? ("granted" as const)
                : ("revoked" as const),
              preference: own.preference,
            };
        return Result.ok(
          projectionPayload(desktopBillingDraftSettingsUpdateResponseSchema, {
            revision: timestampCasTokenText(own.revision),
            ...settings,
          }),
        );
      },
    ),
    {
      type: "independent",
      reason:
        "Updates only the authenticated person's consent and preference through the organization/user primary-key upsert; no shared aggregate state is mutated.",
    },
  );

/**
 * The one settings change that reaches the route while the deployment is off:
 * a body that is exactly `{"type":"withdraw_consent"}`. A body much longer
 * than that is something else and is not read.
 */
export const consentWithdrawalException: DeploymentFeatureException = {
  maxBytes: 64,
  admits: (body) => {
    const parsed = Result.try((): unknown => JSON.parse(body));
    return (
      parsed.isOk() && v.is(desktopBillingDraftWithdrawalSchema, parsed.value)
    );
  },
};

export const readBillingDraftSettings =
  createDesktopBillingDraftSettingsReadEndpoint();
export const updateBillingDraftSettings =
  createDesktopBillingDraftSettingsUpdateEndpoint();
