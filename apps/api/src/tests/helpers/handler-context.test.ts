import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditEvent,
  type AuditRecorder,
} from "@/api/lib/audit-log";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const event = {
  action: AUDIT_ACTION.UPDATE,
  resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
  resourceId: "workspace_test",
} as const satisfies AuditEvent;

const transaction = () => asTestRaw<Parameters<AuditRecorder>[0]>({});
const missingRecorderMessage =
  "createTestHandlerContext: no audit recorder provided";

describe("handler contexts require explicit audit collaborators", () => {
  test.each(["direct", "scoped"] as const)(
    "the unconfigured %s recorder refuses an event",
    async (type) => {
      const context = createTestHandlerContext();
      const recorder =
        type === "direct"
          ? context.recordAuditEvent
          : context.createAuditRecorder({ workspaceId: null });

      expect(
        await rejectionOf((async () => await recorder(transaction(), event))()),
      ).toMatchObject({
        message: expect.stringContaining(missingRecorderMessage),
      });
    },
  );

  test("explicit direct and scoped recorders receive their own events", async () => {
    const directEvents: AuditEvent[] = [];
    const scopedEvents: AuditEvent[] = [];
    const context = createTestHandlerContext({
      recordAuditEvent: auditRecorderDouble((events) => {
        directEvents.push(...events);
      }),
      createAuditRecorder: () =>
        auditRecorderDouble((events) => {
          scopedEvents.push(...events);
        }),
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

  test("a direct recorder also serves the scoped recorder factory", async () => {
    const events: AuditEvent[] = [];
    const context = createTestHandlerContext({
      recordAuditEvent: auditRecorderDouble((recorded) => {
        events.push(...recorded);
      }),
    });

    await context.createAuditRecorder({ workspaceId: null })(
      transaction(),
      event,
    );
    await context.recordAuditEvent(transaction(), event);

    expect(events).toEqual([event, event]);
  });

  test("a scoped recorder factory also serves the direct recorder", async () => {
    const events: AuditEvent[] = [];
    const context = createTestHandlerContext({
      createAuditRecorder: () =>
        auditRecorderDouble((recorded) => {
          events.push(...recorded);
        }),
    });

    await context.recordAuditEvent(transaction(), event);
    await context.createAuditRecorder({ workspaceId: null })(
      transaction(),
      event,
    );

    expect(events).toEqual([event, event]);
  });
});
