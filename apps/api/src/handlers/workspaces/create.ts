import { panic, Result } from "better-result";
import { and, count, eq, ilike, inArray } from "drizzle-orm";
import * as v from "valibot";

import { defaultMatterVisibilityFor } from "@stll/api-contract";

import { member } from "@/api/db/auth-schema";
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
import { createErrorCapture } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { checkDemoAccountOperation } from "@/api/lib/auth/demo-account";
import { AVT_LAYOUT_DISCOVERY_FEATURE_ACCESS } from "@/api/lib/auth/feature-access/view-eligibility";
import type { SafeId } from "@/api/lib/branded-types";
import {
  defaultVarcharSchema,
  resourceIdSchema,
  withDescription,
} from "@/api/lib/custom-schema";
import { lockMatterStewardship } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import {
  allocateMatterReference,
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { buildDefaultViewRows } from "@/api/lib/views";
import { parseViewLayoutSafe } from "@/api/lib/views-schema";
import { createWorkspaceInTransaction } from "@/api/lib/workspaces/create-workspace-row";
import { nextAvailableMatterName } from "@/api/lib/workspaces/matter-name";
import { matterVisibilitySchema } from "@/api/lib/workspaces/visibility";

// `visibility` decides who can see the matter. Unless the creator chooses,
// a matter without a client is personal (assigned_only, led by its creator)
// and a client matter gets the client default (defaultMatterVisibilityFor).
// `memberUserIds` adds members alongside the creator either way.
const createWorkspaceBodySchema = v.object({
  id: resourceIdSchema("workspace"),
  clientId: v.optional(
    resourceIdSchema("contact", {
      description: "Contact ID to attach in the client role",
    }),
  ),
  memberUserIds: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(128))),
      v.maxLength(LIMITS.workspaceMembersCount - 1),
    ),
  ),
  name: withDescription(defaultVarcharSchema, "Matter name"),
  filePropertyName: defaultVarcharSchema,
  visibility: v.optional(
    matterVisibilitySchema({
      description:
        "Who can see the matter: all_members (every internal member), " +
        "admins_and_assigned (owners, admins and assigned members) or " +
        "assigned_only (assigned members only). Defaults to assigned_only " +
        "(only assigned members; the creator leads) for a matter without a " +
        "client, and to admins_and_assigned for a client matter.",
    }),
  ),
});

const config = {
  contract: "patch",
  featureAccess: AVT_LAYOUT_DISCOVERY_FEATURE_ACCESS,
  description:
    "Create a new matter (name required; pass clientId to attach a client " +
    "contact). visibility decides who can see it: all_members reaches every " +
    "internal member without an assignment (never external users); " +
    "admins_and_assigned reaches owners, admins and the assigned members; " +
    "assigned_only reaches only the assigned members. Without visibility, a " +
    "matter with a client is admins_and_assigned and one without a client is " +
    "personal: assigned_only, visible only to its creator. The creator " +
    "becomes the matter lead. " +
    "Returns the matter ID.",
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
  body: v.InferOutput<typeof createWorkspaceBodySchema>;
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
  if ((body.memberUserIds?.length ?? 0) > 0) {
    yield* checkDemoAccountOperation(userEmail);
  }
  const visibility =
    body.visibility ??
    defaultMatterVisibilityFor({ hasClient: body.clientId !== undefined });
  const txResult = yield* Result.await(
    resultTx(safeDb, async (tx) => {
      // The creator is always a member; requested members join them
      // whether or not the matter has a client.
      const requestedMemberUserIds =
        body.memberUserIds !== undefined
          ? Array.from(new Set(body.memberUserIds))
          : [];

      const grantedUserIds = [...new Set([userId, ...requestedMemberUserIds])];
      await lockMatterStewardship({
        tx,
        requests: [
          { organizationId, workspaceIds: [body.id], userIds: grantedUserIds },
        ],
        mode: "update",
      });
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
            .orderBy(member.id)
            .limit(grantedUserIds.length),
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
      // of org-validated members for the insert below.
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

      const newName = nextAvailableMatterName(
        body.name,
        duplicatedNames.map(({ name }) => name),
      );

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

      // The database creates the matter in this transaction's organization
      // and, when the creator would not reach it otherwise, assigns them, so
      // the inserts below pass the row policies through the access rule.
      await createWorkspaceInTransaction(tx, {
        id: body.id,
        clientId: body.clientId ?? null,
        name: newName,
        reference,
        visibility,
        // The creator leads the matter. Only the lead or an organization
        // owner/admin may change who can see it or who leads it, so a matter
        // created by a member is never left without someone who can.
        leadUserId: userId,
      });

      const workspaceId = body.id;

      await tx
        .insert(workspaceMembers)
        .values(
          workspaceMemberUserIds.map((memberUserId: SafeId<"user">) => ({
            workspaceId,
            userId: memberUserId,
          })),
        )
        .onConflictDoNothing({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        });

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
              visibility,
              memberCount: workspaceMemberUserIds.length,
            },
          },
        },
      });

      await enqueueWorkspaceSearchRepairs(tx, [workspaceId]);

      return Result.ok({ id: body.id });
    }),
  );

  flushWorkspaceSearchRepairs([txResult.id]).catch(
    createErrorCapture(
      handlerErrorContext("createWorkspaceHandler.flushWorkspaceSearchRepairs"),
    ),
  );

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
