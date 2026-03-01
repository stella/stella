import { sql } from "drizzle-orm";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import { db } from "@/api/db";
import { matterCounters, properties, views, workspaces } from "@/api/db/schema";
import type { ViewConfig } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
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
  organizationId: SafeId<"organization">;
  body: CreateWorkspacesBodySchema;
};

export const createWorkspacesHandler = ({
  organizationId,
  body,
}: CreateWorkspacesHandlerProps) => {
  return db.transaction(async (tx) => {
    const workspacesResult = await tx.query.workspaces.findMany({
      columns: {
        name: true,
      },
      where: {
        organizationId,
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
      where: { organizationId },
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

    await tx.insert(properties).values([
      {
        workspaceId: body.id,
        name: body.filePropertyName,
        content: { type: "file", version: 1 },
        tool: { version: 1, type: "manual-input" },
        system: true,
        kinds: ["document"],
      },
    ]);

    const emptyConfig: ViewConfig = {
      filters: [],
      sorts: [],
      visibleProperties: [],
      columnSizing: {},
      columnOrder: [],
    };

    await tx.insert(views).values([
      {
        workspaceId: body.id,
        name: "Table",
        layout: "table",
        config: emptyConfig,
        position: 0,
      },
      {
        workspaceId: body.id,
        name: "Files",
        layout: "filesystem",
        config: emptyConfig,
        position: 1,
      },
    ]);

    return;
  });
};
