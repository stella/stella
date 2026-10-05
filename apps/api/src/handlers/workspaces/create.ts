import { Result, panic } from "better-result";
import { and, count, eq, ilike, inArray, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { member } from "@/api/db/auth-schema";
import { SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import type { SafeDb } from "@/api/db/safe-db";
import { resultTx } from "@/api/db/safe-db";
import {
  contacts,
  properties,
  workspaceMembers,
  workspaces,
  workspaceViews,
} from "@/api/db/schema";
import { organizationWorkspaceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { checkDemoAccountOperation } from "@/api/lib/auth/demo-account";
import { AVT_LAYOUT_DISCOVERY_FEATURE_ACCESS } from "@/api/lib/auth/feature-access/view-eligibility";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tDefaultVarchar,
  tSafeId,
  withDescription,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import {
  allocateMatterReference,
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { buildDefaultViewRows } from "@/api/lib/views";
import { parseViewLayoutSafe } from "@/api/lib/views-schema";

// A request without `clientId` creates a personal matter (initially
// visible only to the creator). With `clientId`, it's a normal
// client matter and `memberUserIds` may add additional members.
const createWorkspaceBodySchema = t.Object({
  id: tSafeId("workspace"),
  clientId: t.Optional(
    tSafeId("contact", {
      description: "Contact ID to attach in the client role",
    }),
  ),
  memberUserIds: t.Optional(
    t.Array(t.String({ maxLength: 128 }), {
      maxItems: LIMITS.workspaceMembersCount - 1,
    }),
  ),
  name: withDescription(tDefaultVarchar, "Matter name"),
  filePropertyName: tDefaultVarchar,
});

const config = {
  featureAccess: AVT_LAYOUT_DISCOVERY_FEATURE_ACCESS,
  description:
    "Create a new matter (name required; pass clientId to attach a client " +
    "contact). Returns the matter ID.",
  permissions: { workspace: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: organizationWorkspaceRealtimeUpdates,
  mcp: { type: "tool", name: "save_matter" },
  body: createWorkspaceBodySchema,
} satisfies HandlerConfig;

export type CreateWorkspaceHandlerProps = {
  userEmail: string;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof createWorkspaceBodySchema>;
};

// Shared matter-creation logic reused by the HTTP handler and the
// `save_matter` MCP tool, so both emit identical audit events and
// search-index writes.
export const createWorkspaceHandler = async function* ({
  userEmail,
  safeDb,
  organizationId,
  userId,
  recordAuditEvent,
  body,
}: CreateWorkspaceHandlerProps) {
  if (body.clientId !== undefined && (body.memberUserIds?.length ?? 0) > 0) {
    yield* checkDemoAccountOperation(userEmail);
  }
  const txResult = yield* Result.await(
    resultTx(safeDb, async (tx) => {
      // New personal matters (no clientId) start with exactly one
      // member: the creator. Additional members can be attached
      // through the workspace members endpoint after creation.
      const requestedMemberUserIds =
        body.clientId !== undefined && body.memberUserIds !== undefined
          ? Array.from(new Set(body.memberUserIds))
          : [];

      const grantedUserIds = [...new Set([userId, ...requestedMemberUserIds])];
      const orgFilter = eq(workspaces.organizationId, organizationId);

      const [countResult, duplicatedNames, settings, client, orgMembers] =
        await Promise.all([
          tx.select({ total: count() }).from(workspaces).where(orgFilter),
          tx
            .select({ name: workspaces.name })
            .from(workspaces)
            .where(
              and(
                orgFilter,
                ilike(workspaces.name, `${escapeLike(body.name)}%`),
              ),
            ),
          tx.query.organizationSettings.findFirst({
            where: { organizationId: { eq: organizationId } },
            columns: {
              matterNumberPattern: true,
              matterNumberPadding: true,
            },
          }),
          body.clientId !== undefined
            ? tx
                .select({ id: contacts.id })
                .from(contacts)
                .where(
                  and(
                    eq(contacts.id, body.clientId),
                    eq(contacts.organizationId, organizationId),
                  ),
                )
                .for("update")
                .limit(1)
                .then((rows) => rows.at(0) ?? null)
            : Promise.resolve(null),
          tx
            .select({ userId: member.userId })
            .from(member)
            .where(
              and(
                eq(member.organizationId, organizationId),
                inArray(member.userId, grantedUserIds),
              ),
            )
            // Same order as organization removal's membership locks.
            .orderBy(member.userId)
            .limit(grantedUserIds.length)
            .for("update"),
        ]);

      const activeCount = countResult.at(0)?.total ?? 0;

      if (body.clientId !== undefined && !client) {
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Client not found",
          }),
        );
      }

      if (orgMembers.length !== grantedUserIds.length) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Some users are not members of this organization",
          }),
        );
      }

      // Membership verified above — brand each requested user ID.
      // Combined with the session user.id, this gives a typed list
      // of org-validated members for the insert below. New personal
      // matters start with exactly one member: the creator.
      const workspaceMemberUserIds = Array.from(
        new Set([
          userId,
          ...requestedMemberUserIds.map((id) => brandPersistedUserId(id)),
        ]),
      );

      if (activeCount >= LIMITS.workspacesCount) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Workspaces limit reached",
          }),
        );
      }

      const newName =
        duplicatedNames.length > 0
          ? `${body.name} (${duplicatedNames.length})`
          : body.name;

      const pattern =
        settings?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN;
      const padding =
        settings?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING;
      const now = new Date();
      const referenceResult = await allocateMatterReference({
        tx,
        organizationId,
        pattern,
        now,
        padding,
      });

      if (Result.isError(referenceResult)) {
        return Result.err(referenceResult.error);
      }
      const reference = referenceResult.value;

      await tx.insert(workspaces).values({
        id: body.id,
        organizationId,
        clientId: body.clientId ?? null,
        name: newName,
        reference,
      });

      // Append the new workspace ID to the RLS session variable
      // so child inserts (workspaceMembers, properties) pass the
      // workspace_insert policy within this transaction.
      // The session var is a Postgres array literal: {id1,id2}.
      await tx.execute(
        sql`SELECT set_config(
          ${SETTING_WORKSPACE_IDS},
          array_append(
            current_setting(${SETTING_WORKSPACE_IDS}, true)::text[],
            ${body.id}
          )::text,
          true
        )`,
      );

      const workspaceId = body.id;

      await tx.insert(workspaceMembers).values(
        workspaceMemberUserIds.map((memberUserId: SafeId<"user">) => ({
          workspaceId,
          userId: memberUserId,
        })),
      );

      const fileProperty = await tx
        .insert(properties)
        .values([
          {
            workspaceId,
            name: body.filePropertyName,
            content: { type: "file", version: 1 },
            tool: { version: 1, type: "manual-input" },
            // The system file column is user-managed (uploads), not
            // computed — fresh from creation.
            status: "fresh",
            system: true,
            kinds: ["document"],
          },
        ])
        .returning({ id: properties.id })
        .then((rows) => rows.at(0));

      if (!fileProperty) {
        panic("Failed to create workspace file property");
      }

      // Seed the default views at creation so listing them stays a pure read
      // (a read-only credential must not be able to mint views by listing).
      // The table view pins the file column, which is why this runs after the
      // file property exists.
      const seededViews = await tx
        .insert(workspaceViews)
        .values(
          buildDefaultViewRows({
            workspaceId,
            filePropertyId: fileProperty.id,
          }),
        )
        .returning();

      const viewAuditEvents: AuditEvent[] = seededViews.map((view) => ({
        workspaceId,
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.VIEW,
        resourceId: view.id,
        changes: {
          created: {
            old: null,
            new: {
              name: view.name,
              layoutType: parseViewLayoutSafe(view.layout).type,
              position: view.position,
            },
          },
        },
        metadata: { reason: "default-seed" },
      }));

      await recordAuditEvent(tx, viewAuditEvents);

      await recordAuditEvent(tx, {
        workspaceId,
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
        resourceId: workspaceId,
        changes: {
          created: {
            old: null,
            new: {
              name: newName,
              reference,
              clientId: body.clientId ?? null,
              memberCount: workspaceMemberUserIds.length,
            },
          },
        },
      });

      await enqueueWorkspaceSearchRepairs(tx, [workspaceId]);

      return Result.ok({ id: body.id });
    }),
  );

  flushWorkspaceSearchRepairs([txResult.id]).catch(captureError);

  return Result.ok({ id: txResult.id });
};

const createWorkspaces = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    return yield* createWorkspaceHandler({
      userEmail: user.email,
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      recordAuditEvent,
      body,
    });
  },
);

export default createWorkspaces;
