import { panic } from "better-result";

import readFilesystemTree from "@/api/handlers/entities/filesystem-tree/get";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { queryEntities } from "@/api/lib/entities/query-entities";
import { LIMITS } from "@/api/lib/limits";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";

type EntityReadScalingFixture = Awaited<
  ReturnType<typeof seedEntityReadScaling>
>;

export const measureReadFilesystemTree = async (
  fixture: EntityReadScalingFixture,
) =>
  await runWithMeasuredQueryCounter(async (counter) => {
    const response = await readFilesystemTree.handler(
      asTestRaw<Parameters<typeof readFilesystemTree.handler>[0]>({
        workspaceId: fixture.workspaceId,
        user: { id: fixture.userId },
        session: { activeOrganizationId: fixture.organizationId },
        memberRole: sessionMemberRole("owner"),
        body: { limit: 10, fieldIds: fixture.propertyIds.slice(0, 1) },
        safeDb: fixture.safeDb,
        request: new Request(
          "https://example.test/v1/entities/filesystem-tree",
        ),
        route:
          "/v1/entities/:workspaceId/filesystem-tree" satisfies ApiRoutePath,
      }),
    );
    if (response instanceof HttpStatusResponse) {
      panic("Filesystem scaling requires a successful handler response");
    }
    return {
      statements: counter.count,
      transactionRoundTrips: counter.transactions,
      responseBytes: Buffer.byteLength(JSON.stringify(response)),
      rows: response.items.length,
    };
  });

export const measureCompleteFilesystemTree = async (
  large: EntityReadScalingFixture,
) =>
  await runWithMeasuredQueryCounter(async (counter) => {
    const result = (
      await queryEntities({
        textMode: "full",
        safeDb: large.safeDb,
        scope: { type: "matter", workspaceId: large.workspaceId },
        currentUserId: large.userId,
        currentOrganizationId: large.organizationId,
        filters: [],
        sorts: [],
        limit: LIMITS.entitiesCount,
        fieldMode: "full",
        fieldIds: [],
        excludedKinds: ["task"],
      })
    ).unwrap();
    return {
      statements: counter.count,
      transactionRoundTrips: counter.transactions,
      responseBytes: Buffer.byteLength(
        JSON.stringify({
          entities: result.entities,
          ancestorLinks: [],
        }),
      ),
      rows: result.entities.length,
    };
  });
