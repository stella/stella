import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createRecoverMatterSteward } from "./update";

const workspaceId = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000001",
);
const organizationId = toSafeId<"organization">("org_recovery");
const userId = toSafeId<"user">("actor_recovery");
const stewardUserId = toSafeId<"user">("steward_recovery");
const recordAuditEvent = () => {};
type RecoveryContext = Parameters<
  ReturnType<typeof createRecoverMatterSteward>["handler"]
>[0];
const context = (memberRole: RecoveryContext["memberRole"]): RecoveryContext =>
  asTestRaw<RecoveryContext>({
    request: new Request("https://example.test/workspaces/recovery", {
      method: "POST",
    }),
    route: "/workspaces/:workspaceId/recover-steward",
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    memberRole,
    params: { workspaceId },
    body: { stewardUserId },
    createAuditRecorder: () => recordAuditEvent,
  });

for (const memberRole of [
  sessionMemberRole("member"),
  sessionMemberRole("external"),
  authorizedMemberRole({
    role: "owner",
    credential: { type: "attenuated", permissions: { workspace: ["read"] } },
  }),
]) {
  test("recovery refuses credentials without organization management authority before opening a transaction", async () => {
    let called = false;
    const recovery = createRecoverMatterSteward({
      recoverInTransaction: async () => {
        called = true;
      },
    });
    const response = await recovery.handler(context(memberRole));
    expect(called).toBe(false);
    expect(response).toMatchObject({ code: 403 });
  });
}

for (const role of ["owner", "admin"] as const) {
  test(`${role} recovery binds organization, actor and target and returns no metadata`, async () => {
    const calls: unknown[] = [];
    const recovery = createRecoverMatterSteward({
      recoverInTransaction: async (options) => {
        calls.push(options);
      },
    });
    const response = await recovery.handler(context(sessionMemberRole(role)));
    expect(calls).toEqual([
      {
        organizationId,
        workspaceId,
        actorUserId: userId,
        stewardUserId,
        recordAuditEvent,
      },
    ]);
    expect(response).toMatchObject({ code: 204 });
    expect(JSON.stringify(response)).not.toContain(workspaceId);
    expect(JSON.stringify(response)).not.toContain(stewardUserId);
  });
}

for (const status of [404, 409] as const) {
  test(`recovery preserves a ${status} refusal without metadata`, async () => {
    const recovery = createRecoverMatterSteward({
      recoverInTransaction: async () => {
        throw new HandlerError({ status, message: "Recovery refused" });
      },
    });
    const response = await recovery.handler(
      context(sessionMemberRole("owner")),
    );
    expect(response).toMatchObject({
      code: status,
      response: { message: "Recovery refused" },
    });
  });
}
