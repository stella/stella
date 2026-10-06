import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  chatMessages,
  chatThreads,
  chatTurns,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import getMessages from "./list";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const createdAt = new Date("2026-01-01T00:00:00.000Z");
const settledAt = new Date("2026-01-01T00:10:00.000Z");
const startedAt = new Date("2026-01-01T00:09:00.000Z");

const seedFixture = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Timing fixture",
    slug: organizationId,
    createdAt,
  });
  await db.insert(user).values({
    id: userId,
    name: "Timing fixture",
    email: `${userId}@example.test`,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "member",
    createdAt,
  });
  await db.insert(workspaces).values(
    [workspaceId, otherWorkspaceId].map((id) => ({
      id,
      organizationId,
      name: "Timing matter",
      reference: id,
    })),
  );
  const safeDb = createSafeDb(
    markRlsDatabase(db),
    [workspaceId],
    organizationId,
    userId,
  );
  return { db, organizationId, userId, workspaceId, otherWorkspaceId, safeDb };
};

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
  if (!databaseUrl) {
    panic("DATABASE_URL required for message timing tests");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient();
    const fixture = await seedFixture(db);
    try {
      await run(fixture);
    } finally {
      await db
        .delete(chatThreads)
        .where(eq(chatThreads.organizationId, fixture.organizationId));
      await db
        .delete(workspaces)
        .where(
          inArray(workspaces.id, [
            fixture.workspaceId,
            fixture.otherWorkspaceId,
          ]),
        );
      await db
        .delete(organization)
        .where(eq(organization.id, fixture.organizationId));
      await db.delete(user).where(eq(user.id, fixture.userId));
    }
  });
};

const seedMessages = async (
  fixture: Fixture,
  workspaceId: SafeId<"workspace">,
) => {
  const threadId = createSafeId<"chatThread">();
  const userMessageId = createSafeId<"chatMessage">();
  const assistantMessageId = createSafeId<"chatMessage">();
  await fixture.db.insert(chatThreads).values({
    id: threadId,
    organizationId: fixture.organizationId,
    userId: fixture.userId,
    workspaceId,
    title: "Timing thread",
  });
  await fixture.db.insert(chatMessages).values(
    [
      { id: userMessageId, role: "user", createdAt },
      { id: assistantMessageId, role: "assistant", createdAt: settledAt },
    ].map((message) => ({
      ...message,
      threadId,
      workspaceId,
      userId: fixture.userId,
      content: {
        version: 1 as const,
        data: [{ type: "text" as const, text: "Synthetic timing message" }],
      },
    })),
  );
  return { threadId, userMessageId, assistantMessageId, workspaceId };
};

type Messages = Awaited<ReturnType<typeof seedMessages>>;
type SeedTurnOptions = {
  fixture: Fixture;
  messages: Messages;
  durationMs: number | null;
  state: "completed" | "running" | "awaiting-user" | "failed" | "cancelled";
};

const seedTurn = async ({
  fixture,
  messages,
  durationMs,
  state,
}: SeedTurnOptions) => {
  const common = {
    id: createSafeId<"chatTurn">(),
    organizationId: fixture.organizationId,
    userId: fixture.userId,
    workspaceId: messages.workspaceId,
    threadId: messages.threadId,
    userMessageId: messages.userMessageId,
    timingMessageId: messages.assistantMessageId,
    activeDurationMs: durationMs,
    createdAt,
  };
  switch (state) {
    case "completed":
      await fixture.db.insert(chatTurns).values({
        ...common,
        status: state,
        assistantMessageId: messages.assistantMessageId,
        settledAt,
      });
      return;
    case "running":
      await fixture.db.insert(chatTurns).values({
        ...common,
        status: state,
        activeStartedAt: durationMs === null ? null : startedAt,
        executionId: Bun.randomUUIDv7(),
        leaseExpiresAt: settledAt,
      });
      return;
    case "awaiting-user":
      await fixture.db.insert(chatTurns).values({
        ...common,
        status: state,
        assistantMessageId: messages.assistantMessageId,
        interactionType: "approval",
        interactionToolCallId: "synthetic-approval",
      });
      return;
    case "failed":
      await fixture.db.insert(chatTurns).values({
        ...common,
        status: state,
        assistantMessageId: messages.assistantMessageId,
        failureCode: "provider-error",
        failureRetryable: true,
        settledAt,
      });
      return;
    case "cancelled":
      await fixture.db.insert(chatTurns).values({
        ...common,
        status: state,
        cancellationReason: "user-stop",
        settledAt,
      });
      return;
    default: {
      const exhaustive: never = state;
      panic(`Unhandled timing fixture state: ${exhaustive}`);
    }
  }
};

const readResponse = async (fixture: Fixture, messages: Messages) =>
  await getMessages.handler(
    asTestRaw<Parameters<typeof getMessages.handler>[0]>({
      params: { threadId: messages.threadId },
      query: { workspaceId: messages.workspaceId },
      safeDb: fixture.safeDb,
      user: { id: fixture.userId },
      session: { activeOrganizationId: fixture.organizationId },
      orgAIConfig: null,
      memberRole: sessionMemberRole("member"),
      request: new Request("http://localhost/v1/chat/threads/messages"),
      getWorkspaceAccess: async (id: SafeId<"workspace">) =>
        id === fixture.workspaceId ? { id, status: "active" } : null,
    }),
  );

const readMessages = async (fixture: Fixture, messages: Messages) => {
  const response = await readResponse(fixture, messages);
  if ("code" in response) {
    panic(`Message endpoint refused timing fixture: ${response.code}`);
  }
  return response;
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("message active timing (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("message active timing (postgres)", () => {
    test.each(["completed", "awaiting-user", "failed", "cancelled"] as const)(
      "%s exposes the sum of active spans without the user pause",
      async (state) => {
        await withFixture(async (fixture) => {
          const messages = await seedMessages(fixture, fixture.workspaceId);
          await seedTurn({
            fixture,
            messages,
            durationMs: 4000,
            state: "completed",
          });
          await seedTurn({ fixture, messages, durationMs: 7000, state });
          const response = await readMessages(fixture, messages);
          expect(
            response.messages.find(
              ({ id }) => id === messages.assistantMessageId,
            )?.metadata?.turnTiming,
          ).toEqual({ status: "finished", durationMs: 11_000 });
          expect(
            response.messages.find(({ id }) => id === messages.userMessageId)
              ?.metadata?.turnTiming,
          ).toBeUndefined();
          expect(response.messages).toHaveLength(2);
        });
      },
    );

    test("a running continuation returns accumulated duration and its server clock anchor", async () => {
      await withFixture(async (fixture) => {
        const messages = await seedMessages(fixture, fixture.workspaceId);
        await seedTurn({
          fixture,
          messages,
          durationMs: 4000,
          state: "completed",
        });
        await seedTurn({
          fixture,
          messages,
          durationMs: 7000,
          state: "running",
        });
        const response = await readMessages(fixture, messages);
        const timing = response.messages.find(
          ({ id }) => id === messages.assistantMessageId,
        )?.metadata?.turnTiming;
        expect(timing).toMatchObject({
          status: "running",
          durationMs: 11_000,
        });
        if (timing?.status !== "running") {
          panic("Expected a running timing anchor");
        }
        expect(Date.parse(timing.startedAt)).toBe(startedAt.getTime());
      });
    });

    test("unknown spans and messages without turn rows omit timing", async () => {
      await withFixture(async (fixture) => {
        const messages = await seedMessages(fixture, fixture.workspaceId);
        expect(
          (await readMessages(fixture, messages)).messages.every(
            (message) => message.metadata?.turnTiming === undefined,
          ),
        ).toBe(true);
        await seedTurn({
          fixture,
          messages,
          durationMs: 4000,
          state: "completed",
        });
        await seedTurn({
          fixture,
          messages,
          durationMs: null,
          state: "completed",
        });
        const response = await readMessages(fixture, messages);
        expect(response.messages).toHaveLength(2);
        expect(
          response.messages.find(({ id }) => id === messages.assistantMessageId)
            ?.metadata?.turnTiming,
        ).toBeUndefined();
      });
    });

    test("a different matter cannot expose messages or their timing", async () => {
      await withFixture(async (fixture) => {
        const messages = await seedMessages(fixture, fixture.otherWorkspaceId);
        await seedTurn({
          fixture,
          messages,
          durationMs: 7000,
          state: "completed",
        });
        expect(await readResponse(fixture, messages)).toMatchObject({
          code: 404,
          response: { message: "Workspace not found" },
        });
      });
    });
  });
}
