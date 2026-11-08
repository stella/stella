import { Result } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import type { rootDb } from "@/api/db/root";
import { admitOAuthCredential } from "@/api/lib/auth/oauth-grant-admission";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

let registrationRows: {
  registrationId: string | null;
}[] = [];
let selectCalls = 0;
const selectMock = () => {
  selectCalls += 1;
  return queryBuilder;
};
const queryBuilder = {
  from: () => queryBuilder,
  leftJoin: () => queryBuilder,
  limit: async () => registrationRows,
};
const database = asTestRaw<Pick<typeof rootDb, "select">>({
  select: selectMock,
});

const { resolveAgentAuditExecution } = await import("./agent-audit-principal");

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000002");

describe("resolveAgentAuditExecution", () => {
  beforeEach(() => {
    registrationRows = [];
    selectCalls = 0;
  });

  test("attributes an unregistered OAuth client to its user through MCP", async () => {
    const execution = resolveAgentAuditExecution({
      credential: Result.unwrap(
        await admitOAuthCredential({
          credential: {
            clientId: "first-party-cli",
            issuedAt: 1_700_000_000,
            type: "oauth_client",
          },
          organizationId,
          userId,
          db: database,
        }),
      ),
      userId,
    });

    expect(execution).toEqual({
      performer: { id: userId, type: "user" },
      trigger: { source: "mcp", type: "direct" },
    });
  });

  test("attributes a delegated user token to its user through MCP", () => {
    const execution = resolveAgentAuditExecution({
      credential: { type: "delegated_user" },
      userId,
    });

    expect(execution).toEqual({
      performer: { id: userId, type: "user" },
      trigger: { source: "mcp", type: "direct" },
    });
    expect(selectCalls).toBe(0);
  });

  test("binds an agent run to its human owner and run id", () => {
    const execution = resolveAgentAuditExecution({
      credential: { runId: "run-1", type: "agent_run" },
      userId,
    });

    expect(execution).toEqual({
      performer: {
        id: "stella-assistant",
        name: "Stella AI",
        type: "agent",
      },
      runId: "run-1",
      trigger: {
        ownerUserId: userId,
        source: "mcp",
        sourceId: "run-1",
        type: "credential",
      },
    });
  });

  test("promotes a claimed agent registration to agent activity", async () => {
    registrationRows = [
      {
        registrationId: "agent-registration-1",
      },
    ];

    const execution = resolveAgentAuditExecution({
      credential: Result.unwrap(
        await admitOAuthCredential({
          credential: {
            clientId: "registered-agent",
            issuedAt: 1_700_000_000,
            type: "oauth_client",
          },
          organizationId,
          userId,
          db: database,
        }),
      ),
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
