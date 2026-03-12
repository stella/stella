import { sql } from "drizzle-orm";
import { status, t } from 'elysia';
import type { Static } from 'elysia';
import { nanoid } from "nanoid";

import type         { ScopedDb } from "@/api/db";
import { SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import {
  matterCounters,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
// oxlint-disable-next-line no-restricted-imports: freshly-inserted workspace PK for FK usage
import { toSafeId } from '@/api/lib/branded-types';
import type { SafeId } from '@/api/lib/branded-types';

import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
  toReference,
  toScopeKey,
} from "@/api/lib/matter-reference";

export const createWorkspacesBodySchema = t.Object({
  id: tNanoid,
  name: tDefaultVarchar,
  filePropertyName: tDefaultVarchar,
});

type CreateWorkspacesBodySchema = Static<typeof createWorkspacesBodySchema>;

type CreateWorkspacesHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: string;
  body: CreateWorkspacesBodySchema;
};

// After inserting the workspace row, we append the new ID to
// app.workspace_ids so that subsequent inserts into child
// tables (workspaceMembers, properties) pass RLS checks.
export const createWorkspacesHandler = ({
  scopedDb,
  organizationId,
  userId,
  body,
}: CreateWorkspacesHandlerProps) =>
  scopedDb(async (tx) => {
    const workspacesResult = await tx.query.workspaces.findMany({
      columns: {
        name: true,
      },
      where: {
        organizationId: { eq: organizationId },
        status: "active",
      },
    });

    if (workspacesResult.length >= LIMITS.workspacesCount) {
      return status(400, {
        message: "Workspaces limit reached",
      });
    }

    const duplicatedNames = workspacesResult.filter((workspace) =>
      workspace.name.startsWith(body.name),
    );

    const newName =
      duplicatedNames.length > 0
        ? `${body.name} (${duplicatedNames.length})`
        : body.name;

    // Read org settings for matter numbering
    const settings = await tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: {
        matterNumberPattern: true,
        matterNumberPadding: true,
      },
    });

    const pattern =
      settings?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN;
    const padding =
      settings?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING;
    const now = new Date();
    const scopeKey = toScopeKey(pattern, now);

    // Atomic counter increment (upsert)
    const [counter] = await tx
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
      .returning({ lastValue: matterCounters.lastValue });

    const reference = toReference(pattern, now, counter.lastValue, padding);

    await tx.insert(workspaces).values({
      organizationId,
      id: body.id,
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

    const wsId = toSafeId<"workspace">(body.id);

    await tx.insert(workspaceMembers).values({
      workspaceId: wsId,
      userId,
    });

    await tx.insert(properties).values([
      {
        workspaceId: wsId,
        name: body.filePropertyName,
        content: { type: "file", version: 1 },
        tool: { version: 1, type: "manual-input" },
        system: true,
        kinds: ["document"],
      },
    ]);

    return;
  });
