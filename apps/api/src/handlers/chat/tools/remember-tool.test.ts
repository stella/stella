import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createRememberTool } from "@/api/handlers/chat/tools/remember-tool";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import type { ChatDurableRefText } from "@/api/lib/chat/ref-registry";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import type { MemberRole } from "@/api/lib/member-roles";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
const memoryId = toSafeId<"aiMemory">(Bun.randomUUIDv7());

type RememberHarnessOptions = {
  role?: MemberRole;
  workspaceStatus?: AccessibleWorkspace["status"];
};

const rememberHarness = ({
  role = "member",
  workspaceStatus = "active",
}: RememberHarnessOptions) => {
  const inserted: unknown[] = [];
  const audited: unknown[] = [];
  const { getCallCount, safeDb } = createScopedDbMock({
    insert: () => ({
      values: (values: unknown) => {
        inserted.push(values);
        return {
          onConflictDoNothing: () => ({
            returning: async () => await Promise.resolve([{ id: memoryId }]),
          }),
        };
      },
    }),
  });
  const recordAuditEvent: AuditRecorder = async (_tx, event) => {
    audited.push(event);
    await Promise.resolve();
  };
  const tool = createRememberTool({
    authority: sessionMemberRole(role),
    organizationId,
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
    audited,
    getCallCount,
    inserted,
    remember: async (input: Parameters<typeof execute>[0]) =>
      await execute(input, asTestRaw<Parameters<typeof execute>[1]>({})),
  };
};

describe("chat remember tool", () => {
  test("saves matter memory under the chat's matter with an audit event", async () => {
    const harness = rememberHarness({});
    expect(
      await harness.remember({
        content: "Opposing counsel accepted the extended deadline",
        kind: "decision",
        scope: "workspace",
      }),
    ).toEqual({ status: "saved" });
    expect(harness.inserted).toEqual([
      expect.objectContaining({
        organizationId,
        scope: "workspace",
        userId: null,
        workspaceId,
        kind: "decision",
        source: "tool",
        createdBy: userId,
      }),
    ]);
    expect(harness.audited).toHaveLength(1);
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
