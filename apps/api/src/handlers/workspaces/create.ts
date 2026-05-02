import { Result, panic } from "better-result";
import { and, count, eq, ilike, inArray, sql } from "drizzle-orm";
import { t } from "elysia";

import { member } from "@/api/db/auth-schema";
import { SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import {
  contacts,
  matterCounters,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
  toReference,
  toScopeKey,
} from "@/api/lib/matter-reference";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { upsertWorkspaceSearchDocument } from "@/api/lib/search/index-global";

const config = {
  permissions: { workspace: ["create"] },
  body: t.Object({
    id: tSafeId("workspace"),
    clientId: tSafeId("contact"),
    memberUserIds: t.Optional(
      t.Array(t.String({ maxLength: 128 }), {
        maxItems: LIMITS.workspaceMembersCount - 1,
      }),
    ),
    name: tDefaultVarchar,
    filePropertyName: tDefaultVarchar,
  }),
} satisfies HandlerConfig;

const createWorkspaces = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, request, body }) {
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const organizationId = session.activeOrganizationId;
        const requestedMemberUserIds =
          body.memberUserIds === undefined
            ? []
            : Array.from(new Set(body.memberUserIds));

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
            tx
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
              .then((rows) => rows.at(0) ?? null),
            requestedMemberUserIds.length > 0
              ? tx
                  .select({ userId: member.userId })
                  .from(member)
                  .where(
                    and(
                      eq(member.organizationId, organizationId),
                      inArray(member.userId, requestedMemberUserIds),
                    ),
                  )
                  .for("update")
              : Promise.resolve([]),
          ]);

        const activeCount = countResult.at(0)?.total ?? 0;

        if (!client) {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Client not found",
          };
        }

        if (orgMembers.length !== requestedMemberUserIds.length) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Some users are not members of this organization",
          };
        }

        // Membership verified above — brand each requested user ID.
        // Combined with the session user.id, this gives a typed list
        // of org-validated members for the insert below.
        const workspaceMemberUserIds = Array.from(
          new Set([
            user.id,
            ...requestedMemberUserIds.map((id) => brandPersistedUserId(id)),
          ]),
        );

        if (activeCount >= LIMITS.workspacesCount) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Workspaces limit reached",
          };
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
        const scopeKey = toScopeKey(pattern, now);

        // Atomic counter increment (upsert)
        const counter = await tx
          .insert(matterCounters)
          .values({
            id: createSafeId<"matterCounter">(),
            organizationId,
            scopeKey,
            lastValue: 1,
          })
          .onConflictDoUpdate({
            target: [matterCounters.organizationId, matterCounters.scopeKey],
            set: {
              lastValue: sql`${matterCounters.lastValue} + 1`,
            },
          })
          .returning({ lastValue: matterCounters.lastValue })
          .then((r) => r.at(0));

        if (!counter) {
          panic("Failed to create matter counter");
        }

        const reference = toReference({
          pattern,
          now,
          seq: counter.lastValue,
          padding,
        });

        await tx.insert(workspaces).values({
          id: body.id,
          organizationId,
          clientId: body.clientId,
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
          workspaceMemberUserIds.map((userId: SafeId<"user">) => ({
            workspaceId,
            userId,
          })),
        );

        await tx.insert(properties).values([
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
        ]);

        await writeAuditLog(
          {
            ...createAuditContext({
              organizationId,
              workspaceId,
              userId: user.id,
              request,
            }),
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: workspaceId,
            changes: {
              created: {
                old: null,
                new: {
                  name: newName,
                  reference,
                  clientId: body.clientId,
                  memberCount: workspaceMemberUserIds.length,
                },
              },
            },
          },
          tx,
        );

        return {
          ok: true as const,
          id: body.id,
        };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: txResult.status,
          message: txResult.message,
        }),
      );
    }

    upsertWorkspaceSearchDocument(txResult.id).catch(captureError);

    return Result.ok({ id: txResult.id });
  },
);

export default createWorkspaces;
