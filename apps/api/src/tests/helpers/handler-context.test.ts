import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditEvent,
  type AuditRecorder,
} from "@/api/lib/audit-log";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const event = {
  action: AUDIT_ACTION.UPDATE,
  resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
  resourceId: "workspace_test",
} as const satisfies AuditEvent;

const transaction = () => asTestRaw<Parameters<AuditRecorder>[0]>({});

// Never executed: these calls guard the requirements over all test files.
const checkRequiredCollaborators = () => {
  // @ts-expect-error audit choice is required
  createTestHandlerContext({ safeDb: NO_DB, scopedDb: NO_DB });
  // @ts-expect-error safeDb choice is required
  createTestHandlerContext({ audit: NO_AUDIT, scopedDb: NO_DB });
  // @ts-expect-error scopedDb choice is required
  createTestHandlerContext({ audit: NO_AUDIT, safeDb: NO_DB });
  // @ts-expect-error collaborator choices cannot all be omitted
  createTestHandlerContext();
  createTestHandlerContext({
    audit: NO_AUDIT,
    safeDb: NO_DB,
    scopedDb: NO_DB,
    // @ts-expect-error the direct recorder is derived from the audit choice
    recordAuditEvent: auditRecorderDouble(),
  });
};
void checkRequiredCollaborators;

describe("handler contexts require explicit collaborators", () => {
  test.each(["direct", "scoped"] as const)(
    "NO_AUDIT refuses an event through the %s recorder",
    async (type) => {
      const context = createTestHandlerContext({
        audit: NO_AUDIT,
        safeDb: NO_DB,
        scopedDb: NO_DB,
      });
      const recorder =
        type === "direct"
          ? context.recordAuditEvent
          : context.createAuditRecorder({ workspaceId: null });
      expect(
        await rejectionOf((async () => await recorder(transaction(), event))()),
      ).toMatchObject({
        message: expect.stringContaining(
          "NO_AUDIT path recorded an audit event",
        ),
      });
    },
  );

  test.each(["safeDb", "scopedDb"] as const)(
    "NO_DB refuses access through %s",
    (type) => {
      const context = createTestHandlerContext({
        audit: NO_AUDIT,
        safeDb: NO_DB,
        scopedDb: NO_DB,
      });
      expect(async () => context[type](async () => undefined)).toThrow(
        "NO_DB path accessed the database",
      );
    },
  );

  test("one audit choice receives direct and scoped events", async () => {
    const events: AuditEvent[] = [];
    const context = createTestHandlerContext({
      audit: auditRecorderDouble((recorded) => {
        events.push(...recorded);
      }),
      safeDb: NO_DB,
      scopedDb: NO_DB,
    });
    await context.recordAuditEvent(transaction(), event);
    await context.createAuditRecorder({ workspaceId: null })(
      transaction(),
      event,
    );
    expect(events).toEqual([event, event]);
  });

  test("a workspace handler sees the supplied audit recorder", async () => {
    const events: AuditEvent[] = [];
    const recorder = auditRecorderDouble((recorded) => {
      events.push(...recorded);
    });
    const endpoint = createSafeHandler(
      {
        permissions: { workspace: ["read"] },
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "health_infra" },
      },
      async function* ({ recordAuditEvent }) {
        expect(recordAuditEvent).toBe(recorder);
        await recordAuditEvent(transaction(), event);
        return Result.ok({ recorded: true });
      },
    );
    const context = createTestHandlerContext<
      Parameters<typeof endpoint.handler>[0]
    >({
      audit: recorder,
      safeDb: NO_DB,
      scopedDb: NO_DB,
    });
    expect(await endpoint.handler(context)).toEqual({ recorded: true });
    expect(events).toEqual([event]);
  });

  test("an explicit scoped factory receives its own events", async () => {
    const directEvents: AuditEvent[] = [];
    const scopedEvents: AuditEvent[] = [];
    const context = createTestHandlerContext({
      audit: auditRecorderDouble((events) => {
        directEvents.push(...events);
      }),
      createAuditRecorder: () =>
        auditRecorderDouble((events) => {
          scopedEvents.push(...events);
        }),
      safeDb: NO_DB,
      scopedDb: NO_DB,
    });
    await context.recordAuditEvent(transaction(), event);
    const scopedEvent = { ...event, workspaceId: null };
    await context.createAuditRecorder({ workspaceId: null })(
      transaction(),
      scopedEvent,
    );
    expect(directEvents).toEqual([event]);
    expect(scopedEvents).toEqual([scopedEvent]);
  });
});
