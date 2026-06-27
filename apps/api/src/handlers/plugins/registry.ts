import { and, eq } from "drizzle-orm"
import { Result } from "better-result"

import { workspacePlugins } from "@/api/db/schema"
import type { SafeDb } from "@/api/db"
import type { SafeId } from "@/api/lib/branded-types"

export type WorkspacePluginRow = {
  workspaceId: SafeId<"workspace">
  pluginId: string
  version: string
  config: Record<string, unknown>
  enabled: boolean
  installedAt: Date
  installedBy: SafeId<"user">
}

export const listWorkspacePlugins = async (
  db: SafeDb,
  workspaceId: SafeId<"workspace">,
): Promise<Result<WorkspacePluginRow[], Error>> =>
  Result.await(
    db((tx) =>
      tx
        .select()
        .from(workspacePlugins)
        .where(
          and(
            eq(workspacePlugins.workspaceId, workspaceId),
            eq(workspacePlugins.enabled, true),
          ),
        ),
    ),
  )

export const installWorkspacePlugin = async (
  db: SafeDb,
  input: {
    workspaceId: SafeId<"workspace">
    pluginId: string
    version: string
    config: Record<string, unknown>
    installedBy: SafeId<"user">
  },
): Promise<Result<WorkspacePluginRow, Error>> =>
  Result.await(
    db((tx) =>
      tx
        .insert(workspacePlugins)
        .values({
          workspaceId: input.workspaceId,
          pluginId: input.pluginId,
          version: input.version,
          config: input.config,
          installedBy: input.installedBy,
        })
        .onConflictDoNothing()
        .returning(),
    ).then((rows) => rows[0]),
  )

export const uninstallWorkspacePlugin = async (
  db: SafeDb,
  workspaceId: SafeId<"workspace">,
  pluginId: string,
): Promise<Result<void, Error>> =>
  Result.await(
    db((tx) =>
      tx
        .delete(workspacePlugins)
        .where(
          and(
            eq(workspacePlugins.workspaceId, workspaceId),
            eq(workspacePlugins.pluginId, pluginId),
          ),
        ),
    ).then(() => undefined),
  )
