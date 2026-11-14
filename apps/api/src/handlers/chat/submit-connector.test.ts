import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";
import {
  CONNECT_CONNECTOR_TOOL_NAME,
  connectConnectorOutputSchema,
} from "@stll/api-contract/chat-connector";
import type { ConnectConnectorInput } from "@stll/api-contract/chat-connector";

import type { SafeDb } from "@/api/db/safe-db";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import submitConnector from "@/api/handlers/chat/submit-connector";
import { createSafeId } from "@/api/lib/branded-types";
import { authorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const toolCallId = "connector-request";
const input = {
  connectorSlug: "sample-connector",
  purpose: "Search the sample source for the cited decision",
} satisfies ConnectConnectorInput;

const assistantContent = (
  state: "input-complete" | "complete" = "input-complete",
  name:
    | typeof CONNECT_CONNECTOR_TOOL_NAME
    | "ask-user" = CONNECT_CONNECTOR_TOOL_NAME,
) => {
  if (name === "ask-user") {
    return toPersistedChatMessageContentV3({
      data: [
        {
          type: "tool-call",
          metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
          id: toolCallId,
          name,
          arguments: "{}",
          state,
        },
      ],
    });
  }
  return toPersistedChatMessageContentV3({
    data: [
      {
        type: "tool-call",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        id: toolCallId,
        name,
        arguments: JSON.stringify(input),
        input,
        state,
        ...(state === "complete"
          ? {
              output: {
                status: "declined",
                connectorSlug: input.connectorSlug,
              },
            }
          : {}),
      },
    ],
  });
};

type Script = {
  thread?: boolean;
  turn?: { status: string; content: unknown } | null;
  connected?: boolean;
};

/**
 * A transaction that answers the handler's reads in order (thread, pending
 * turn, usable connection) and every lock as held. The connection read is
 * counted so a declined answer is shown not to need it.
 */
const scriptedDb = ({
  thread = true,
  turn = { status: "awaiting-user", content: assistantContent() },
  connected = false,
}: Script) => {
  const selects: unknown[][] = [
    thread ? [{ id: "thread" }] : [],
    turn === null ? [] : [turn],
    connected ? [{ id: "connection" }] : [],
  ];
  const reads = { count: 0 };
  const select = () => {
    reads.count += 1;
    const rows = selects.shift() ?? [];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      limit: async () => await Promise.resolve(rows),
    };
    return chain;
  };
  const tx = { execute: async () => [{ id: "locked" }], select };
  const safeDb: SafeDb = async (operation) =>
    Result.ok(await operation(asTestRaw<Parameters<typeof operation>[0]>(tx)));
  return { reads, safeDb };
};

const submit = async ({
  body,
  safeDb,
  memberRole,
}: {
  body: unknown;
  safeDb: SafeDb | typeof NO_DB;
  memberRole?: ReturnType<typeof authorizedMemberRole>;
}) =>
  await submitConnector.handler(
    createTestHandlerContext<Parameters<typeof submitConnector.handler>[0]>({
      safeDb,
      scopedDb: NO_DB,
      audit: NO_AUDIT,
      ...(memberRole === undefined ? {} : { memberRole }),
      params: { threadId: createSafeId<"chatThread">(), toolCallId },
      body,
    }),
  );

describe("connector request answers", () => {
  test("confirms a connection only when a usable one is stored", async () => {
    const connected = await submit({
      body: { decision: "connected" },
      safeDb: scriptedDb({ connected: true }).safeDb,
    });
    expect(connected).toEqual({
      status: "connected",
      connectorSlug: input.connectorSlug,
    });
    expect(v.is(connectConnectorOutputSchema, connected)).toBe(true);

    const notYet = await submit({
      body: { decision: "connected" },
      safeDb: scriptedDb({ connected: false }).safeDb,
    });
    expect(notYet).toMatchObject({
      code: 409,
      response: { message: "Connector is not connected yet" },
    });
  });

  test("answers a decline without reading connections", async () => {
    const { reads, safeDb } = scriptedDb({ connected: true });
    const declined = await submit({ body: { decision: "declined" }, safeDb });
    expect(declined).toEqual({
      status: "declined",
      connectorSlug: input.connectorSlug,
    });
    // Thread and pending turn only.
    expect(reads.count).toBe(2);
  });

  test("hides another user's or organization's thread", async () => {
    const result = await submit({
      body: { decision: "declined" },
      safeDb: scriptedDb({ thread: false }).safeDb,
    });
    expect(result).toMatchObject({ code: 404 });
  });

  test("refuses a request the turn no longer waits on", async () => {
    for (const turn of [
      null,
      { status: "completed", content: assistantContent() },
      { status: "awaiting-user", content: assistantContent("complete") },
      {
        status: "awaiting-user",
        content: assistantContent("input-complete", "ask-user"),
      },
    ]) {
      const result = await submit({
        body: { decision: "declined" },
        safeDb: scriptedDb({ turn }).safeDb,
      });
      expect(result).toMatchObject({ code: 409 });
    }
  });

  test("rejects malformed answers and connector answers without connector access before any read", async () => {
    expect(
      await submit({ body: { decision: "maybe" }, safeDb: NO_DB }),
    ).toMatchObject({ code: 400 });
    expect(
      await submit({
        body: { decision: "connected" },
        safeDb: NO_DB,
        memberRole: authorizedMemberRole({
          role: "member",
          credential: {
            type: "attenuated",
            permissions: { chat: ["create"] },
          },
        }),
      }),
    ).toMatchObject({ code: 403 });
  });
});
