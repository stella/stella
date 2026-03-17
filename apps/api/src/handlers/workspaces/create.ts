import { and, count, eq, ilike, sql } from "drizzle-orm";
import { status, t } from "elysia";
import { nanoid } from "nanoid";

import { SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import {
  matterCounters,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
// oxlint-disable-next-line no-restricted-imports: freshly-inserted workspace PK for FK usage
import { toSafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
  toReference,
  toScopeKey,
} from "@/api/lib/matter-reference";

const config = {
  permissions: { workspace: ["create"] },
  body: t.Object({
    id: tNanoid,
    name: tDefaultVarchar,
    filePropertyName: tDefaultVarchar,
  }),
} satisfies HandlerConfig;

const createWorkspaces = createRootHandler(
  config,
  async ({ scopedDb, session, user, body }) =>
    await scopedDb(async (tx) => {
      const organizationId = session.activeOrganizationId;

      const orgFilter = eq(workspaces.organizationId, organizationId);

      const [countResult, duplicatedNames, settings] = await Promise.all([
        tx.select({ total: count() }).from(workspaces).where(orgFilter),
        tx
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(
            and(orgFilter, ilike(workspaces.name, `${escapeLike(body.name)}%`)),
          ),
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: organizationId } },
          columns: {
            matterNumberPattern: true,
            matterNumberPadding: true,
          },
        }),
      ]);

      const activeCount = countResult.at(0)?.total ?? 0;

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
          id: nanoid(),
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
        throw new Error("Failed to create matter counter");
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

      const workspaceId = toSafeId<"workspace">(body.id);

      await tx.insert(workspaceMembers).values({
        workspaceId,
        userId: user.id,
      });

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

      return;
    }),
);

export default createWorkspaces;
