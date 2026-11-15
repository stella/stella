import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { STELLA_MCP_APP_LIMITS } from "@stll/api-contract/stella-mcp-app";
import { CASE_LAW_RESULTS_RESOURCE_URI } from "@stll/mcp-apps/resource-uri";

import { toSafeId } from "@/api/lib/branded-types";
import { appCallArgumentsHash } from "@/api/lib/desktop-runner/app-calls";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";

import { recordAgentRunAppCall } from "./agent-run-app-calls";

type Recorded = Parameters<DesktopRunnerControl["recordAppCall"]>[0];

const organizationId = toSafeId<"organization">("org_app_calls");
const userId = toSafeId<"user">("user_app_calls");
const agentRun = {
  credential: { type: "agent_run", runId: "run-one" },
  organizationId,
  userId,
} as const;
const args = { query: "unfair dismissal" };
const answered = {
  content: [{ type: "text" as const, text: '{"results":[]}' }],
  structuredContent: { results: [] },
};

const recordWith = async (
  options: Omit<Parameters<typeof recordAgentRunAppCall>[0], "record">,
) => {
  const recorded: Recorded[] = [];
  await recordAgentRunAppCall({
    ...options,
    record: async (call) => {
      recorded.push(call);
      return await Promise.resolve(Result.ok(true));
    },
  });
  return recorded;
};

describe("what the MCP server keeps of a local run's app calls", () => {
  test("keeps an agent run's successful call of a tool a chat app presents", async () => {
    expect(
      await recordWith({
        context: agentRun,
        toolName: "search_case_law",
        args,
        result: answered,
      }),
    ).toEqual([
      {
        owner: { userId, organizationId },
        runId: "run-one",
        toolName: "search_case_law",
        argumentsHash: appCallArgumentsHash(args),
        resourceUri: CASE_LAW_RESULTS_RESOURCE_URI,
        result: { results: [] },
      },
    ]);
  });

  test("keeps nothing for any other caller, tool or answer", async () => {
    const cases: Omit<Parameters<typeof recordAgentRunAppCall>[0], "record">[] =
      [
        {
          context: {
            credential: { type: "delegated_user" },
            organizationId,
            userId,
          },
          toolName: "search_case_law",
          args,
          result: answered,
        },
        {
          context: { organizationId, userId },
          toolName: "search_case_law",
          args,
          result: answered,
        },
        {
          context: agentRun,
          toolName: "read_document",
          args,
          result: answered,
        },
        {
          context: agentRun,
          toolName: "search_case_law",
          args,
          result: { ...answered, isError: true },
        },
        {
          context: agentRun,
          toolName: "search_case_law",
          args,
          result: { content: answered.content },
        },
        {
          context: agentRun,
          toolName: "search_case_law",
          args,
          result: {
            ...answered,
            structuredContent: {
              text: "x".repeat(STELLA_MCP_APP_LIMITS.payloadChars),
            },
          },
        },
      ];
    for (const options of cases) {
      expect(await recordWith(options)).toEqual([]);
    }
  });

  test("a failure to keep the call does not fail it", async () => {
    await recordAgentRunAppCall({
      context: agentRun,
      toolName: "search_case_law",
      args,
      result: answered,
      record: async () =>
        await Promise.resolve(
          Result.err(new DatabaseError({ message: "unavailable" })),
        ),
    });
  });
});
