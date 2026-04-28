import { Result } from "better-result";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { entities, properties } from "@/api/db/schema";
import { createToolFunction } from "@/api/handlers/chat/tools/execute/execute-tool-function";
import {
  getMattersContract,
  listMattersContract,
} from "@/api/handlers/chat/tools/execute/org-manifest";
import { buildPaginatedResult } from "@/api/handlers/chat/tools/execute/pagination";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { ensureAllowedWorkspaceIds } from "@/api/handlers/chat/tools/execute/utils";
import type { SafeId } from "@/api/lib/branded-types";

type OrgFunctionContext = {
  allowedWorkspaceIds: SafeId<"workspace">[];
  refRegistry: ChatRefRegistry;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
};

export const createReadonlyOrgFunctionRegistry = ({
  organizationId,
  refRegistry,
  safeDb,
  allowedWorkspaceIds,
}: OrgFunctionContext) => ({
  [listMattersContract.name]: createToolFunction(
    listMattersContract,
    async function* (input) {
      const offset = input.offset ?? 0;

      const workspaceRows = yield* await safeDb((tx) =>
        tx.query.workspaces.findMany({
          where: {
            id: { in: allowedWorkspaceIds },
            organizationId: { eq: organizationId },
            status: { eq: "active" },
          },
          columns: {
            id: true,
            name: true,
            reference: true,
            lastActivityAt: true,
          },
          orderBy: {
            lastActivityAt: "desc",
          },
          limit: input.limit + 1,
          offset,
        }),
      );

      return Result.ok(
        buildPaginatedResult({
          items: workspaceRows.map((workspace) => ({
            lastActivityAt: workspace.lastActivityAt.toISOString(),
            matterRef: refRegistry.toMatterRef(workspace.id),
            mention: refRegistry.toMatterMention({
              label: workspace.name,
              workspaceId: workspace.id,
            }),
            name: workspace.name,
            reference: workspace.reference,
          })),
          limit: input.limit,
          offset,
        }),
      );
    },
  ),
  [getMattersContract.name]: createToolFunction(
    getMattersContract,
    async function* (input) {
      const scopedWorkspaceIds = yield* refRegistry
        .resolveMatterRefs(input.matterRefs)
        .andThen((workspaceIds) =>
          ensureAllowedWorkspaceIds({ allowedWorkspaceIds, workspaceIds }),
        );

      const workspaceRows = yield* await safeDb((tx) =>
        tx.query.workspaces.findMany({
          where: {
            id: { in: scopedWorkspaceIds },
            organizationId: { eq: organizationId },
            status: { eq: "active" },
          },
          columns: {
            id: true,
            name: true,
            reference: true,
            color: true,
            createdAt: true,
            lastActivityAt: true,
          },
          extras: {
            entityCount: (ws) =>
              tx.$count(entities, eq(entities.workspaceId, ws.id)),
            propertyCount: (ws) =>
              tx.$count(properties, eq(properties.workspaceId, ws.id)),
          },
          with: {
            client: {
              columns: {
                displayName: true,
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        }),
      );

      return Result.ok(
        workspaceRows.map((workspace) => ({
          clientName: workspace.client?.displayName ?? null,
          color: workspace.color,
          createdAt: workspace.createdAt.toISOString(),
          entityCount: workspace.entityCount,
          lastActivityAt: workspace.lastActivityAt.toISOString(),
          matterRef: refRegistry.toMatterRef(workspace.id),
          mention: refRegistry.toMatterMention({
            label: workspace.name,
            workspaceId: workspace.id,
          }),
          name: workspace.name,
          propertyCount: workspace.propertyCount,
          reference: workspace.reference,
        })),
      );
    },
  ),
});
