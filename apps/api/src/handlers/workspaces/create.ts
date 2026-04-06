import { panic } from "better-result";
import { and, count, eq, ilike, inArray, sql } from "drizzle-orm";
import { status, t } from "elysia";

import { member } from "@/api/db/auth-schema";
import { SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import {
  contacts,
  matterCounters,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
  toReference,
  toScopeKey,
} from "@/api/lib/matter-reference";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

const config = {
  permissions: { workspace: ["create"] },
  body: t.Object({
    id: tNanoid,
    clientId: tNanoid,
    memberUserIds: t.Optional(
      t.Array(t.String({ maxLength: 128 }), {
        maxItems: LIMITS.workspaceMembersCount - 1,
      }),
    ),
    name: tDefaultVarchar,
    filePropertyName: tDefaultVarchar,
  }),
} satisfies HandlerConfig;

const createWorkspaces = createRootHandler(
  config,
  async ({ scopedDb, session, user, body }) =>
    await scopedDb(async (tx) => {
      const organizationId = session.activeOrganizationId;
      const requestedMemberUserIds =
        body.memberUserIds === undefined
          ? []
          : Array.from(new Set(body.memberUserIds));
      const workspaceMemberUserIds = Array.from(
        new Set([user.id, ...requestedMemberUserIds]),
      );

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
        return status(404, {
          message: "Client not found",
        });
      }

      if (orgMembers.length !== requestedMemberUserIds.length) {
        return status(400, {
          message: "Some users are not members of this organization",
        });
      }

      if (activeCount >= LIMITS.workspacesCount) {
        return status(400, {
          message: "Workspaces limit reached",
        });
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
          id: crypto.randomUUID(),
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

      const workspaceId = brandPersistedWorkspaceId(body.id);

      await tx.insert(workspaceMembers).values(
        workspaceMemberUserIds.map((userId) => ({
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
          system: true,
          kinds: ["document"],
        },
      ]);

      return {
        id: body.id,
      };
    }),
);

export default createWorkspaces;
