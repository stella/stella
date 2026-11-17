import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_QUEUE_HOLD_REASON } from "@stll/api-contract/chat-queue";
import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatLocalRunTarget,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import { createTestClock } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  chatQueueHolds,
  chatThreads,
  PROFESSIONAL_USE_ACCEPTANCE_SOURCE,
} from "@/api/db/schema";
import type { QueuedChatSend } from "@/api/handlers/chat/chat-schema";
import type { LocalRunRoute } from "@/api/handlers/chat/local-run-route";
import {
  type ChatQueueDrainDependencies,
  createChatQueueDrainer,
} from "@/api/handlers/chat/queue/chat-queue-drain";
import { enqueueChatMessageOnTx } from "@/api/handlers/chat/queue/chat-queue-store";
import { recordAccountProfessionalUse } from "@/api/lib/auth/professional-use";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * The queue sends a message as the member who queued it. One queued without
 * a target (the phone queues none) runs where its thread runs: on the
 * thread's computer, waiting for it while it is away, never on stella's own
 * models by default.
 */

// The sender reads the queue and proves the member through the root pool, so
// the fixture is written through it too.
const db = rootDb;
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const clock = createTestClock();

const CODEX: ChatLocalRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
  reasoningEffort: null,
};

const seedThread = async (runsOn: ChatLocalRunTarget | null) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Queue drain fixture",
    slug: organizationId,
    createdAt: new Date(clock.now()),
  });
  await recordNewOrganizationAccessState(db, {
    organizationId,
    now: new Date(clock.now()),
  });
  await db.insert(user).values({
    id: userId,
    name: "Fixture member",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  const accepted = await recordAccountProfessionalUse({
    userId,
    source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive,
  });
  expect(accepted.isOk()).toBe(true);
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(clock.now()),
  });
  const threadId = createSafeId<"chatThread">();
  await db.insert(chatThreads).values({
    id: threadId,
    organizationId,
    userId,
    title: "Queue drain fixture",
    workspaceId: null,
    chatLocalRunTarget: runsOn,
  });
  return {
    threadId,
    cleanUp: async () => {
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await deleteOrganizationsForTest(db, [organizationId]);
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

const enqueue = async (
  threadId: SafeId<"chatThread">,
  runTarget: ChatRunTarget | undefined,
) => {
  const id = createSafeId<"chatMessage">();
  const send: QueuedChatSend = {
    sendMode: CHAT_SEND_MODE.rawOverride,
    message: { id, role: "user", parts: [{ type: "text", content: "next" }] },
    ...(runTarget === undefined ? {} : { runTarget }),
  };
  const queued = await db.transaction(
    async (tx) =>
      await enqueueChatMessageOnTx({
        id,
        send,
        threadId,
        tx,
        uploadedFileIds: [],
      }),
  );
  expect(queued.type).toBe("queued");
};

const ROUTED: LocalRunRoute = {
  type: "routed",
  destination: {
    desktopId: Bun.randomUUIDv7(),
    harness: CODEX.harness,
    harnessVersion: "0.50.0",
    model: CODEX.model,
    reasoningEffort: null,
    approvals: CODEX.approvals,
    capabilities: [],
    linkedFolderId: null,
  },
};
const NO_COMPUTER: LocalRunRoute = { type: "no_computer" };

/**
 * A drainer whose send records the target it was handed and starts the turn,
 * and whose member's computers answer `route`.
 */
const drainerWith = (route: LocalRunRoute) => {
  const sent: unknown[] = [];
  const routed: ChatLocalRunTarget[] = [];
  const dependencies: ChatQueueDrainDependencies = {
    send: asTestRaw<ChatQueueDrainDependencies["send"]>(
      async (context: {
        body: { forwardedProps: { runTarget?: unknown } };
      }) => {
        sent.push(context.body.forwardedProps.runTarget);
        return await Promise.resolve(new Response(null));
      },
    ),
    routeLocalRun: async ({ target }) => {
      routed.push(target);
      return await Promise.resolve(Result.ok(route));
    },
    signal: new AbortController().signal,
  };
  return { drainer: createChatQueueDrainer(dependencies), routed, sent };
};

const holdOf = async (threadId: SafeId<"chatThread">) =>
  (
    await db
      .select({ reason: chatQueueHolds.reason })
      .from(chatQueueHolds)
      .where(eq(chatQueueHolds.threadId, threadId))
  ).at(0)?.reason;

if (!databaseUrl || !enabled) {
  describe.skip("chat queue drain (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("chat queue drain (postgres)", () => {
    test("a message queued without a target runs on the thread's computer", async () => {
      const fixture = await seedThread(CODEX);
      try {
        await enqueue(fixture.threadId, undefined);
        const { drainer, routed, sent } = drainerWith(ROUTED);

        await drainer.drain(fixture.threadId);

        expect(routed).toEqual([CODEX]);
        expect(sent).toEqual([CODEX]);
      } finally {
        await fixture.cleanUp();
      }
    });

    test("a message queued without a target waits while the thread's computer is away", async () => {
      const fixture = await seedThread(CODEX);
      try {
        await enqueue(fixture.threadId, undefined);
        const { drainer, sent } = drainerWith(NO_COMPUTER);

        await drainer.drain(fixture.threadId);

        expect(sent).toEqual([]);
        expect(await holdOf(fixture.threadId)).toBe(
          CHAT_QUEUE_HOLD_REASON.computerAway,
        );
      } finally {
        await fixture.cleanUp();
      }
    });

    test("a message queued for stella runs there on a thread that runs on a computer", async () => {
      const fixture = await seedThread(CODEX);
      try {
        await enqueue(fixture.threadId, CHAT_CLOUD_RUN_TARGET);
        const { drainer, routed, sent } = drainerWith(NO_COMPUTER);

        await drainer.drain(fixture.threadId);

        expect(routed).toEqual([]);
        expect(sent).toEqual([CHAT_CLOUD_RUN_TARGET]);
      } finally {
        await fixture.cleanUp();
      }
    });

    test("a message queued without a target on a thread that runs on stella runs there", async () => {
      const fixture = await seedThread(null);
      try {
        await enqueue(fixture.threadId, undefined);
        const { drainer, routed, sent } = drainerWith(ROUTED);

        await drainer.drain(fixture.threadId);

        expect(routed).toEqual([]);
        expect(sent).toEqual([CHAT_CLOUD_RUN_TARGET]);
      } finally {
        await fixture.cleanUp();
      }
    });
  });
}
