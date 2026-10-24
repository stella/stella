import { panic } from "better-result";
import { ElysiaCustomStatusResponse } from "elysia";

import readFilesystemTree from "@/api/handlers/entities/filesystem-tree/get";
import readEntities from "@/api/handlers/entities/list";
import readVersions from "@/api/handlers/entities/versions/list";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";
import { measureReadFilesystemTree } from "@/api/tests/read-scaling/filesystem-tree";

type ReadFixture = Awaited<ReturnType<typeof seedEntityReadScaling>>;

/** The same handler objects are mounted by Elysia and exercised by the harness. */
export const readScalingScenarios = [
  {
    name: "entity list",
    handler: readEntities.handler,
    measure: async (fixture: ReadFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await readEntities.handler(
          asTestRaw<Parameters<typeof readEntities.handler>[0]>({
            workspaceId: fixture.workspaceId,
            user: { id: fixture.userId },
            session: { activeOrganizationId: fixture.organizationId },
            memberRole: sessionMemberRole("owner"),
            body: { limit: 10, fieldIds: fixture.propertyIds.slice(0, 1) },
            safeDb: fixture.safeDb,
            request: new Request("https://example.test/v1/entities/query"),
            route: "/v1/entities/:workspaceId/query",
          }),
        );
        if (response instanceof ElysiaCustomStatusResponse) {
          panic("Entity list scaling requires a successful handler response");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.items.length,
        };
      }),
  },
  {
    name: "filesystem tree",
    handler: readFilesystemTree.handler,
    measure: measureReadFilesystemTree,
  },
  {
    name: "version history",
    handler: readVersions.handler,
    measure: async (fixture: ReadFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await readVersions.handler(
          asTestRaw<Parameters<typeof readVersions.handler>[0]>({
            workspaceId: fixture.workspaceId,
            user: { id: fixture.userId },
            session: { activeOrganizationId: fixture.organizationId },
            memberRole: sessionMemberRole("owner"),
            params: { entityId: fixture.versionEntityId },
            query: {},
            safeDb: fixture.safeDb,
            request: new Request("https://example.test/v1/entities/versions"),
            route: "/v1/entities/:workspaceId/entity/:entityId/versions",
          }),
        );
        if (response instanceof ElysiaCustomStatusResponse) {
          panic("Version scaling requires a successful handler response");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.versions.length,
        };
      }),
  },
];
