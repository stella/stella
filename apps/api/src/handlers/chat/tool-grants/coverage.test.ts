import { Result } from "better-result";
import { expect, test } from "bun:test";

import readChatToolGrantCoverage from "@/api/handlers/chat/tool-grants/coverage";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const threadId = "00000000-0000-4000-8000-000000000010";
const connectorId = "00000000-0000-4000-8000-000000000001";
const otherConnectorId = "00000000-0000-4000-8000-000000000002";

/** A transaction whose reads answer in order. */
const setup = ({
  reads,
  toolName,
}: {
  reads: unknown[][];
  toolName: string;
}) => {
  const queued = [...reads];
  const chain = {
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where: () => ({ limit: async () => queued.shift() ?? [] }),
  };
  type Context = Parameters<typeof readChatToolGrantCoverage.handler>[0];
  const context = asTestRaw<Context>({
    query: { threadId, toolName },
    safeDb: async (operation: (tx: unknown) => unknown) =>
      Result.ok(await operation(chain)),
    session: { activeOrganizationId: toSafeId<"organization">("org_1") },
    user: { id: toSafeId<"user">("user_1") },
    memberRole: sessionMemberRole("member"),
    request: new Request(
      "https://api.example.test/v1/chat/tool-grants/coverage",
    ),
    route: "/v1/chat/tool-grants/coverage" satisfies ApiRoutePath,
  });
  return context;
};

test("a stored grant for a built-in tool covers it", async () => {
  const context = setup({
    toolName: "web_search",
    reads: [[{ id: "grant_1" }]],
  });
  expect(await readChatToolGrantCoverage.handler(context)).toEqual({
    covered: true,
  });
});

test("a tool that asks on every call is never covered", async () => {
  const context = setup({
    toolName: "use_connector_secret",
    reads: [[{ id: "grant_1" }]],
  });
  expect(await readChatToolGrantCoverage.handler(context)).toEqual({
    covered: false,
  });
});

test("a connector tool whose namespace two connectors share is not covered", async () => {
  const context = setup({
    toolName: "mcp__acme_docs__search",
    reads: [
      [
        { id: connectorId, slug: "acme-docs" },
        { id: otherConnectorId, slug: "acme_docs" },
      ],
      [{ id: "grant_1" }],
    ],
  });
  expect(await readChatToolGrantCoverage.handler(context)).toEqual({
    covered: false,
  });
});
