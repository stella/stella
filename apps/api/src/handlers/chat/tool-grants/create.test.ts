import { Result } from "better-result";
import { expect, test } from "bun:test";

import createChatToolGrant from "@/api/handlers/chat/tool-grants/create";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { aggregateExecutionRows } from "@/api/tests/fixtures/aggregate-lock-order";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const threadId = "00000000-0000-4000-8000-000000000010";
const connectorId = "00000000-0000-4000-8000-000000000001";

type Body = {
  scope: "conversation" | "always";
  threadId: string;
  toolName: string;
};

/**
 * A transaction whose reads answer in order: the thread lookup, then (for an
 * external tool) the user's connectors, then the held-grant count.
 */
const setup = ({ body, reads }: { body: Body; reads: unknown[][] }) => {
  const queued = [...reads];
  const inserted: unknown[] = [];
  const audits: unknown[] = [];
  let readCount = 0;
  const nextRead = () => {
    readCount += 1;
    return queued.shift() ?? [];
  };
  const where = () => ({ limit: async () => nextRead() });
  const chain = {
    execute: async (statement: Parameters<typeof aggregateExecutionRows>[0]) =>
      aggregateExecutionRows(statement),
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where,
    insert: () => ({
      values: (value: unknown) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            inserted.push(value);
            return [{ id: "00000000-0000-4000-8000-0000000000aa" }];
          },
        }),
      }),
    }),
  };
  type Context = Parameters<typeof createChatToolGrant.handler>[0];
  const context = asTestRaw<Context>({
    body,
    safeDb: async (operation: (tx: unknown) => unknown) =>
      Result.ok(await operation(chain)),
    session: { activeOrganizationId: toSafeId<"organization">("org_1") },
    user: { id: toSafeId<"user">("user_1") },
    memberRole: sessionMemberRole("member"),
    recordAuditEvent: async (_tx: unknown, value: unknown) => {
      audits.push(value);
    },
    request: new Request("https://api.example.test/v1/chat/tool-grants", {
      method: "POST",
    }),
    route: "/v1/chat/tool-grants" satisfies ApiRoutePath,
  });
  return { audits, context, inserted, reads: () => readCount };
};

test("a tool that asks on every call is refused before anything is read", async () => {
  for (const toolName of ["use_connector_secret"]) {
    const fixture = setup({
      body: { scope: "always", threadId, toolName },
      reads: [[{ id: threadId }], []],
    });
    expect(await createChatToolGrant.handler(fixture.context)).toMatchObject({
      code: 409,
    });
    expect(fixture.reads()).toBe(0);
    expect(fixture.inserted).toEqual([]);
    expect(fixture.audits).toEqual([]);
  }
});

test("a name that is neither an approval-gated tool nor a connector tool is refused", async () => {
  const fixture = setup({
    body: { scope: "always", threadId, toolName: "read_document" },
    reads: [[{ id: threadId }]],
  });
  expect(await createChatToolGrant.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.reads()).toBe(0);
  expect(fixture.inserted).toEqual([]);
});

test("a grant needs the user's own conversation", async () => {
  const fixture = setup({
    body: { scope: "conversation", threadId, toolName: "web_search" },
    reads: [[]],
  });
  expect(await createChatToolGrant.handler(fixture.context)).toMatchObject({
    code: 404,
  });
  expect(fixture.inserted).toEqual([]);
});

test("a built-in tool grant is stored by name for the conversation and audited", async () => {
  const fixture = setup({
    body: { scope: "conversation", threadId, toolName: "web_search" },
    reads: [[{ id: threadId }], []],
  });
  expect(await createChatToolGrant.handler(fixture.context)).toMatchObject({
    created: true,
    mcpConnectorId: null,
    scope: "conversation",
    toolName: "web_search",
  });
  expect(fixture.inserted).toEqual([
    expect.objectContaining({
      chatThreadId: threadId,
      mcpConnectorId: null,
      scope: "conversation",
      toolName: "web_search",
      userId: "user_1",
    }),
  ]);
  expect(fixture.audits).toEqual([
    expect.objectContaining({ resourceType: "chat_tool_grant" }),
  ]);
});

test("an external tool grant covers its connector and applies in every conversation", async () => {
  const fixture = setup({
    body: { scope: "always", threadId, toolName: "mcp__acme__search" },
    reads: [[{ id: threadId }], [{ id: connectorId, slug: "acme" }], []],
  });
  expect(await createChatToolGrant.handler(fixture.context)).toMatchObject({
    created: true,
    mcpConnectorId: connectorId,
    toolName: null,
  });
  expect(fixture.inserted).toEqual([
    expect.objectContaining({
      chatThreadId: null,
      mcpConnectorId: connectorId,
      scope: "always",
      toolName: null,
    }),
  ]);
});

test("an external tool that matches no connected connector stays per-call", async () => {
  const fixture = setup({
    body: { scope: "conversation", threadId, toolName: "mcp__acme__search" },
    reads: [[{ id: threadId }], [{ id: connectorId, slug: "other" }]],
  });
  expect(await createChatToolGrant.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.inserted).toEqual([]);
});
