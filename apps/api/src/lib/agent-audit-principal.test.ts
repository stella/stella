import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

let registrationRows: { id: string }[] = [];
const selectMock = mock(() => queryBuilder);
const queryBuilder = {
  from: () => queryBuilder,
  limit: async () => registrationRows,
  where: () => queryBuilder,
};

void mock.module("@/api/db/root", () => ({
  rootDb: { select: selectMock },
}));

const { resolveAgentAuditExecution } = await import("./agent-audit-principal");

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000002");

describe("resolveAgentAuditExecution", () => {
  beforeEach(() => {
    registrationRows = [];
    selectMock.mockClear();
  });

  test("attributes an unregistered OAuth client to its user through MCP", async () => {
    const execution = await resolveAgentAuditExecution({
      credential: { clientId: "first-party-cli", type: "oauth_client" },
      organizationId,
      userId,
    });

    expect(execution).toEqual({
      performer: { id: userId, type: "user" },
      trigger: { source: "mcp", type: "direct" },
    });
  });

  test("attributes a delegated user token to its user through MCP", async () => {
    const execution = await resolveAgentAuditExecution({
      credential: { type: "delegated_user" },
      organizationId,
      userId,
    });

    expect(execution).toEqual({
      performer: { id: userId, type: "user" },
      trigger: { source: "mcp", type: "direct" },
    });
    expect(selectMock).not.toHaveBeenCalled();
  });

  test("promotes a claimed agent registration to agent activity", async () => {
    registrationRows = [{ id: "agent-registration-1" }];

    const execution = await resolveAgentAuditExecution({
      credential: { clientId: "registered-agent", type: "oauth_client" },
      organizationId,
      userId,
    });

    expect(execution).toEqual({
      performer: {
        id: "agent-registration-1",
        name: null,
        type: "agent",
      },
      trigger: {
        ownerUserId: userId,
        source: "mcp",
        sourceId: "agent-registration-1",
        type: "credential",
      },
    });
  });
});
