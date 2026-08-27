/**
 * What a finished run owes the columns it never planned.
 *
 * A playbook start answered `already-running` materializes its columns and
 * leaves the extraction to the run in flight, so the finalizer's catch-up is
 * the only thing coming for them. Exercised against a real schema because the
 * detector is a query: it reads the durable column state a concurrent start
 * left behind, and the tool-type filter it leans on is what keeps a stale
 * manual column from firing no-op workflows forever.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as authSchema from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import * as schema from "@/api/db/schema";
import { properties } from "@/api/db/schema";
import type { PropertyTool } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { startStragglerCatchUp } from "@/api/lib/workflow/straggler-catchup";
import type { StragglerRunStarter } from "@/api/lib/workflow/straggler-catchup";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

type StartedRun = Parameters<StragglerRunStarter>[0];

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let db: ReturnType<typeof drizzle>;

const ORG_ID = mintAuthProviderId<"organization">();
const USER_ID = "user_straggler_test";
const CONTACT_ID = toSafeId<"contact">(Bun.randomUUIDv7());
/** The workspace whose run just finished. */
const WS_ID = toSafeId<"workspace">(Bun.randomUUIDv7());
/** A second workspace, whose owed work is not this run's to start. */
const OTHER_WS_ID = toSafeId<"workspace">(Bun.randomUUIDv7());

/** The ASK column a playbook materializes: stale, and extracted by the model. */
const ASK_TOOL = {
  version: 1,
  type: "ai-model",
  prompt: "What is the notice period?",
} as const satisfies PropertyTool;

const MANUAL_TOOL = {
  version: 1,
  type: "manual-input",
} as const satisfies PropertyTool;

/** The verdict half of a graded position, materialized stale beside its ASK. */
const VERDICT_TOOL = {
  version: 1,
  type: "playbook-verdict",
  askPropertyId: "01931f4a-0000-7000-8000-0000000000a5",
  rule: { kind: "positionMatch" },
  severity: "medium",
  tiers: { fallbacks: [], acceptableRules: [], notAcceptableRules: [] },
} as const satisfies PropertyTool;

const seedProperty = async ({
  status,
  tool,
  workspaceId,
}: {
  status: "fresh" | "stale";
  tool: PropertyTool;
  workspaceId: SafeId<"workspace">;
}) => {
  const id = toSafeId<"property">(Bun.randomUUIDv7());
  await db.insert(properties).values({
    id,
    workspaceId,
    name: "Termination notice",
    status,
    content: { version: 1, type: "text" },
    tool,
  });
  return id;
};

const clearProperties = async () => {
  await db.delete(properties).where(eq(properties.workspaceId, WS_ID));
  await db.delete(properties).where(eq(properties.workspaceId, OTHER_WS_ID));
};

/** Run the catch-up over the seeded rows and report what it started. */
const runCatchUp = async (): Promise<StartedRun[]> => {
  const startedRuns: StartedRun[] = [];
  await startStragglerCatchUp({
    workspaceId: WS_ID,
    organizationId: ORG_ID,
    userId: toSafeId<"user">(USER_ID),
    scopedDb: asTestRaw<ScopedDb>(
      async (fn: (tx: unknown) => Promise<unknown>) => await fn(db),
    ),
    serviceTier: "flex",
    startWorkflow: async (args) => {
      startedRuns.push(args);
      await Promise.resolve();
    },
  });
  return startedRuns;
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(authSchema.user).values({
      id: USER_ID,
      name: "Straggler",
      email: "straggler@test.local",
    });
    await db.insert(authSchema.organization).values({
      id: ORG_ID,
      name: "Straggler Org",
      slug: "straggler-org",
      createdAt: new Date(),
    });
    await db.insert(schema.contacts).values({
      id: CONTACT_ID,
      organizationId: ORG_ID,
      type: "person",
      displayName: "Straggler Contact",
    });
    await db.insert(schema.workspaces).values([
      {
        id: WS_ID,
        organizationId: ORG_ID,
        clientId: CONTACT_ID,
        name: "Straggler WS",
        reference: "REF-STRAGGLER",
        status: "active",
      },
      {
        id: OTHER_WS_ID,
        organizationId: ORG_ID,
        clientId: CONTACT_ID,
        name: "Other WS",
        reference: "REF-OTHER",
        status: "active",
      },
    ]);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  if (client !== undefined) {
    await client.close();
  }
});

describe("the catch-up a finished run owes", () => {
  test("starts a follow-up run for a column a concurrent start left stale", async () => {
    // The columns a playbook materialized while this workspace was busy: the
    // start was answered `already-running`, so nothing else is coming.
    await seedProperty({ status: "stale", tool: ASK_TOOL, workspaceId: WS_ID });
    try {
      const startedRuns = await runCatchUp();

      expect(startedRuns).toHaveLength(1);
      // Workspace-wide, and on the finished run's tier: the follow-up plans
      // from durable state, not from what the finished run happened to target.
      const started = startedRuns.at(0);
      expect(started?.workspaceId).toBe(WS_ID);
      expect(started?.organizationId).toBe(ORG_ID);
      expect(started?.serviceTier).toBe("flex");
    } finally {
      await clearProperties();
    }
  });

  test("starts nothing when every column is fresh", async () => {
    await seedProperty({ status: "fresh", tool: ASK_TOOL, workspaceId: WS_ID });
    try {
      expect(await runCatchUp()).toEqual([]);
    } finally {
      await clearProperties();
    }
  });

  test("starts a follow-up run for a stale verdict column", async () => {
    // A graded position whose ASK needs no extraction (an empty question
    // materializes a manual, already-fresh ASK) leaves only its verdict column
    // owed. The verdict engine grades it, so it is as much owed work as an
    // extraction is.
    await seedProperty({
      status: "stale",
      tool: VERDICT_TOOL,
      workspaceId: WS_ID,
    });
    try {
      expect(await runCatchUp()).toHaveLength(1);
    } finally {
      await clearProperties();
    }
  });

  test("ignores a stale manual column, which no run would compute", async () => {
    // A manual column sits stale legitimately (a type edit does it) and the
    // planner skips it, so treating it as owed work would fire no-op
    // workflows forever, each one finishing and starting the next.
    await seedProperty({
      status: "stale",
      tool: MANUAL_TOOL,
      workspaceId: WS_ID,
    });
    try {
      expect(await runCatchUp()).toEqual([]);
    } finally {
      await clearProperties();
    }
  });

  test("ignores another workspace's owed work", async () => {
    await seedProperty({
      status: "stale",
      tool: ASK_TOOL,
      workspaceId: OTHER_WS_ID,
    });
    try {
      expect(await runCatchUp()).toEqual([]);
    } finally {
      await clearProperties();
    }
  });
});
