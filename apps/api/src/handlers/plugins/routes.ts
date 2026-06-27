import Elysia from "elysia"
import { eq } from "drizzle-orm"
import { Result } from "better-result"

import { workspacePlugins } from "@/api/db/schema"
import { createSafeHandler } from "@/api/lib/api-handlers"
import { HandlerError } from "@/api/lib/errors/tagged-errors"
import { PluginManifestSchema } from "@/api/lib/tool-config-schema"
import { listWorkspacePlugins, installWorkspacePlugin, uninstallWorkspacePlugin } from "./registry"

const listConfig = {
  permissions: { workspace: ["read"] },
  params: {} as { workspaceId: string },
} as const

const listHandler = createSafeHandler(listConfig, async function* (ctx) {
  const result = yield* Result.await(listWorkspacePlugins(ctx.safeDb, ctx.workspaceId))
  return result
})

const installConfig = {
  permissions: { workspace: ["update"] },
  body: {} as { pluginId: string; version: string; config?: Record<string, unknown> },
  params: {} as { workspaceId: string },
} as const

const installHandler = createSafeHandler(installConfig, async function* (ctx) {
  const { pluginId, version, config } = ctx.body
  const result = yield* Result.await(
    installWorkspacePlugin(ctx.safeDb, {
      workspaceId: ctx.workspaceId,
      pluginId,
      version,
      config: config ?? {},
      installedBy: ctx.user.id,
    }),
  )
  return result
})

const uninstallConfig = {
  permissions: { workspace: ["update"] },
  params: {} as { workspaceId: string; pluginId: string },
} as const

const uninstallHandler = createSafeHandler(uninstallConfig, async function* (ctx) {
  yield* Result.await(
    uninstallWorkspacePlugin(ctx.safeDb, ctx.workspaceId, ctx.params.pluginId),
  )
  return { ok: true }
})

export const pluginRoutes = new Elysia({ prefix: "/workspaces/:workspaceId/plugins" })
  .get("/", listHandler.handler, {
    params: listConfig.params,
    permissions: listConfig.permissions,
  })
  .post("/", installHandler.handler, {
    body: installConfig.body,
    params: installConfig.params,
    permissions: installConfig.permissions,
  })
  .delete("/:pluginId", uninstallHandler.handler, {
    params: uninstallConfig.params,
    permissions: uninstallConfig.permissions,
  })
