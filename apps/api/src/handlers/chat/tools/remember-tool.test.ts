import { beforeEach, describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { env } from "@/api/env";
import { createRememberTool } from "@/api/handlers/chat/tools/remember-tool";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import { toSafeId } from "@/api/lib/branded-types";
import type { ChatDurableRefText } from "@/api/lib/chat/ref-registry";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import type { MemberRole } from "@/api/lib/member-roles";
import { MemoryWriteRefusedError } from "@/api/lib/memory/persist-explicit-memory";
import type {
  persistExplicitMemory,
  PersistExplicitMemoryResult,
} from "@/api/lib/memory/persist-explicit-memory";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
const state = createTestState({ file: import.meta.path, config: env });
beforeEach(() => {
  state.setConfig("FEATURE_AI_MEMORY", true);
  state.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "ai-memory": [{ type: "organization", organizationId }],
  });
});
const memoryId = toSafeId<"aiMemory">(Bun.randomUUIDv7());

type RememberHarnessOptions = {
  persisted?: PersistExplicitMemoryResult;
  role?: MemberRole;
  workspaceStatus?: AccessibleWorkspace["status"];
};

type PersistMemoryOptions = Parameters<typeof persistExplicitMemory>[0];

const rememberHarness = ({
  persisted = { id: memoryId, type: "created" },
  role = "member",
  workspaceStatus = "active",
}: RememberHarnessOptions) => {
  const writes: PersistMemoryOptions[] = [];
  const { getCallCount, safeDb } = createScopedDbMock(
    {},
    {
      featureAccess: {
        identity: { email: "member@example.test", emailVerified: true },
      },
    },
  );
  const recordAuditEvent: AuditRecorder = async () => {
    await Promise.resolve();
  };
  const tool = createRememberTool({
    authority: sessionMemberRole(role),
    organizationId,
    persistMemory: async (options) => {
      writes.push(options);
      return await Promise.resolve(persisted);
    },
    recordAuditEvent,
    safeDb,
    resolveSourceDataWorkspaceIds: () => [workspaceId],
    toDurableRefText: (text) => asTestRaw<ChatDurableRefText>(text),
    userId,
    workspaceId,
    workspaceStatusById: new Map([[workspaceId, workspaceStatus]]),
  });
  const { execute } = tool;
  if (!execute) {
    throw new Error("remember must be server-executed");
  }
  return {
    getCallCount,
    recordAuditEvent,
    remember: async (input: Parameters<typeof execute>[0]) =>
      await execute(input, asTestRaw<Parameters<typeof execute>[1]>({})),
    writes,
  };
};

describe("chat remember tool", () => {
  test("an uninvited account cannot execute a remembered tool", async () => {
    state.setConfig("API_FEATURE_ACCESS_GRANTS", {});
    const harness = rememberHarness({});
    expect(
      await rejectionOf(
        harness.remember({ content: "Use numbered paragraphs" }),
      ),
    ).toMatchObject({ kind: "unavailable" });
    expect(harness.writes).toEqual([]);
  });
  test("saves matter memory under the chat's matter with an audit recorder", async () => {
    const harness = rememberHarness({});
    expect(
      await harness.remember({
        content: "Opposing counsel accepted the extended deadline",
        kind: "decision",
        scope: "workspace",
      }),
    ).toEqual({ status: "saved" });
    expect(harness.writes).toHaveLength(1);
    const write = harness.writes.at(0);
    expect(write?.scope.target).toEqual({
      createdBy: userId,
      kind: "decision",
      organizationId,
      scope: "workspace",
      userId: null,
      workspaceId,
    });
    expect(write?.memory).toMatchObject({
      source: "tool",
      sourceDataWorkspaceIds: [workspaceId],
    });
    expect(write?.recordAuditEvent).toBe(harness.recordAuditEvent);
  });

  test("returns the write's live-authority refusal instead of a saved status", async () => {
    const harness = rememberHarness({
      persisted: {
        error: new MemoryWriteRefusedError({
          code: "forbidden",
          kind: "decision",
          message: "You no longer have permission to save this memory.",
        }),
        type: "authority_unavailable",
      },
    });
    const refusal = await rejectionOf(
      harness.remember({
        content: "Opposing counsel accepted the extended deadline",
        kind: "decision",
        scope: "workspace",
      }),
    );
    expect(refusal).toBeInstanceOf(ChatToolError);
    expect(refusal).toMatchObject({ kind: "invalid-input" });
    expect(harness.writes).toHaveLength(1);
  });

  test("refuses an archived matter's memory with the archive reason, before any write", async () => {
    const harness = rememberHarness({ workspaceStatus: "archived" });
    const refusal = await rejectionOf(
      harness.remember({
        content: "Settlement terms are final",
        kind: "decision",
        scope: "workspace",
      }),
    );
    expect(refusal).toBeInstanceOf(ChatToolError);
    expect(refusal).toMatchObject({
      kind: "invalid-input",
      message: expect.stringContaining("archived"),
    });
    expect(harness.getCallCount()).toBe(0);
  });

  test("refuses matter memory to a chat-capable role without matter update", async () => {
    const harness = rememberHarness({ role: "intern" });
    expect(
      await rejectionOf(
        harness.remember({
          content: "Settlement terms are final",
          kind: "decision",
          scope: "workspace",
        }),
      ),
    ).toMatchObject({
      kind: "invalid-input",
      message: expect.stringContaining("permission"),
    });
    expect(harness.getCallCount()).toBe(0);
    expect(
      await harness.remember({ content: "Prefer British spelling" }),
    ).toEqual({ status: "saved" });
  });

  test("keeps matter-derived kinds out of personal memory", async () => {
    const harness = rememberHarness({});
    expect(
      await rejectionOf(
        harness.remember({
          content: "The client is based in Brno",
          kind: "fact",
        }),
      ),
    ).toMatchObject({
      kind: "invalid-input",
      message: 'Kind "fact" is only allowed on matter-scoped memory.',
    });
    expect(harness.getCallCount()).toBe(0);
  });
});
