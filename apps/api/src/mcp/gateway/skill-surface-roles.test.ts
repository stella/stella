import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { dispatchGatewayToolCall } from "@/api/mcp/gateway/dispatch-call";
import { listGatewayMcpToolDefinitions } from "@/api/mcp/gateway/list-tools";
import {
  getSkillPrompt,
  listSkillPrompts,
} from "@/api/mcp/gateway/skill-prompts";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const AUTO_NAME = "skill__role_auto";
const MANUAL_NAME = "skill__role_manual";

const skillRows = [
  {
    id: toSafeId<"agentSkill">("skill_auto"),
    scope: "private" as const,
    userId: "user_1",
    slug: "role_auto",
    name: "Role auto",
    description: "Automatic fixture",
    version: "1.0.0",
    license: null,
    compatibility: null,
    metadata: {},
    body: "Use the automatic fixture.",
    invocation: "auto" as const,
    origin: "authored" as const,
  },
  {
    id: toSafeId<"agentSkill">("skill_manual"),
    scope: "private" as const,
    userId: "user_1",
    slug: "role_manual",
    name: "Role manual",
    description: "Manual fixture",
    version: "1.0.0",
    license: null,
    compatibility: null,
    metadata: {},
    body: "Use the manual fixture.",
    invocation: "manual" as const,
    origin: "authored" as const,
  },
];

const contextFor = (memberRole: "external" | "owner"): McpRequestContext => {
  const safeDb: McpRequestContext["safeDb"] = async (run) =>
    await Result.ok(
      await run(
        asTestRaw<Transaction>({
          select: (selection: Record<string, unknown>) => {
            const rows = "path" in selection ? [] : skillRows;
            const builder = {
              from: () => builder,
              where: () => builder,
              orderBy: () => builder,
              limit: async () => rows,
            };
            return builder;
          },
        }),
      ),
    );
  return asTestRaw<McpRequestContext>({
    grantedScopes: ["stella:skills"],
    memberRole,
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw<AuditRecorder>(async () => undefined),
    safeDb,
    userEmail: "member@example.test",
    userId: toSafeId<"user">("user_1"),
  });
};

const surfaceResults = async (context: McpRequestContext) => {
  const listedTools = await listGatewayMcpToolDefinitions({
    context,
    mode: "advanced",
    scopes: context.grantedScopes,
  });
  const calledTool = await dispatchGatewayToolCall({
    args: {},
    context,
    mode: "advanced",
    toolName: AUTO_NAME,
  });
  const listedPrompts = await listSkillPrompts({
    context,
    mode: "advanced",
    scopes: context.grantedScopes,
  });
  const prompt = await getSkillPrompt({
    args: undefined,
    context,
    mode: "advanced",
    name: MANUAL_NAME,
  });
  return { calledTool, listedPrompts, listedTools, prompt };
};

describe("skill surfaces follow member authority", () => {
  test("every skill surface requires the shared permission", async () => {
    const denied = await surfaceResults(contextFor("external"));
    expect(
      denied.listedTools.some(({ name }) => name === AUTO_NAME),
    ).toBeFalse();
    expect(denied.calledTool?.type).toBe("internal");
    expect(denied.calledTool?.result.status).toBe("error");
    expect(denied.listedPrompts).toEqual([]);
    expect(Result.isOk(denied.prompt)).toBeFalse();

    const allowed = await surfaceResults(contextFor("owner"));
    expect(
      allowed.listedTools.some(({ name }) => name === AUTO_NAME),
    ).toBeTrue();
    expect(allowed.calledTool?.type).toBe("internal");
    expect(allowed.calledTool?.result.status).toBe("success");
    expect(
      allowed.listedPrompts.some(({ name }) => name === MANUAL_NAME),
    ).toBeTrue();
    expect(Result.isOk(allowed.prompt)).toBeTrue();
  });
});
