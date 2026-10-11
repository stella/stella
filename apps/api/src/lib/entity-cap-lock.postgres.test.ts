import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { entities, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

import {
  lockWorkspaceForEntityCreate,
  lockWorkspacesForEntityCap,
  lockWorkspacesForEntityTransfer,
} from "./entity-cap-lock";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type WorkspaceAcquisition = (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => Promise<unknown>;

const assertCapBarrier = async (
  url: string,
  acquire: WorkspaceAcquisition,
): Promise<void> => {
  await withGatedTestClients(url, async ({ openClient }) => {
    const { db } = openClient();
    const organizationId = mintAuthProviderId<"organization">();
    const workspaceId = createSafeId<"workspace">();
    const entityId = createSafeId<"entity">();
    try {
      await db.insert(organization).values({
        id: organizationId,
        name: "Entity capacity lock fixture",
        slug: `cap-lock-${organizationId}`,
        createdAt: new Date(),
      });
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Entity capacity lock fixture",
        reference: workspaceId,
      });
      await db.insert(entities).values({
        id: entityId,
        workspaceId,
        kind: "document",
        name: "Entity capacity lock fixture",
      });
      await withInterleaving({
        databaseUrl: url,
        schedules: [
          [
            "a.lockWorkspace",
            "b.waitWorkspace",
            "a.lockEntity",
            "a.commit",
            "b.lockEntity",
            "b.commit",
          ],
        ],
        a: {
          steps: [
            {
              name: "lockWorkspace",
              run: async (tx) => {
                await lockWorkspacesForEntityCap(tx, [workspaceId]);
              },
            },
            {
              name: "lockEntity",
              run: async (tx) => {
                expect(
                  await withAggregateLock({
                    aggregate: "entity",
                    id: { id: entityId, workspaceId },
                    mode: "update",
                    tx,
                  }),
                ).toEqual({ status: "locked" });
              },
            },
          ],
        },
        b: {
          steps: [
            {
              name: "waitWorkspace",
              run: async (tx) => {
                await acquire(tx, workspaceId);
              },
            },
            {
              name: "lockEntity",
              run: async (tx) => {
                expect(
                  await withAggregateLock({
                    aggregate: "entity",
                    id: { id: entityId, workspaceId },
                    mode: "update",
                    tx,
                  }),
                ).toEqual({ status: "locked" });
              },
            },
          ],
        },
        reset: async () => {
          expect(
            await db
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.id, entityId)),
          ).toEqual([{ id: entityId }]);
        },
        readState: async () =>
          await db
            .select({ id: entities.id, workspaceId: entities.workspaceId })
            .from(entities)
            .where(eq(entities.id, entityId)),
        invariant: ({ blocked, outcomes, state, sessions }) => {
          expect(sessions.a.pid).not.toBe(sessions.b.pid);
          expect(blocked).toEqual(["b.waitWorkspace"]);
          expect(outcomes.a).toEqual({ status: "committed" });
          expect(outcomes.b).toEqual({ status: "committed" });
          expect(state).toEqual([{ id: entityId, workspaceId }]);
        },
      });
    } finally {
      await db.delete(organization).where(eq(organization.id, organizationId));
    }
  });
};

if (!databaseUrl || !enabled) {
  describe.skip("entity capacity locks (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("entity capacity locks (postgres)", () => {
    test("capacity waits on the matter before the entity against a cap writer", async () => {
      await assertCapBarrier(
        databaseUrl,
        async (tx, workspaceId) =>
          await lockWorkspacesForEntityCap(tx, [workspaceId]),
      );
    });

    test("transfer waits on the matter before the entity against a cap writer", async () => {
      await assertCapBarrier(
        databaseUrl,
        async (tx, workspaceId) =>
          await lockWorkspacesForEntityTransfer(tx, [workspaceId]),
      );
    });

    test("creation waits on the matter before reading its status and locking the entity", async () => {
      await assertCapBarrier(databaseUrl, async (tx, workspaceId) => {
        expect(await lockWorkspaceForEntityCreate(tx, workspaceId)).toBe(
          "active",
        );
      });
    });
  });
}
