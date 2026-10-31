import { Result } from "better-result";
import { expect, test } from "bun:test";
import { getColumns, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { OUTBOUND_FAILURE_OUTCOME_UNKNOWN } from "@stll/api-contract/outbound-action";
import type { OutboundEmailPreview } from "@stll/api-contract/outbound-action";

import { outboundActions } from "@/api/db/schema";
import { createConfirmOutboundActionHandler } from "@/api/handlers/outbound-actions/confirm";
import type { OutboundActionExecutor } from "@/api/handlers/outbound-actions/executors";
import { outboundPreviewHash } from "@/api/handlers/outbound-actions/preview";
import { toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("org_1");
const actionId = "00000000-0000-4000-8000-0000000000a1";

const preview: OutboundEmailPreview = {
  kind: "email.send",
  from: { address: "lawyer@example.test" },
  to: [{ address: "client@example.test" }],
  cc: [],
  bcc: [],
  subject: "Draft agreement",
  bodyText: "Please find the draft attached.",
  attachments: [],
  inReplyTo: null,
};
const previewHash = outboundPreviewHash(preview);

type StoredAction = {
  kind: "email.send";
  status: string;
  // The database clock's verdict, as the handler selects it.
  expired: boolean;
  previewEncrypted: Buffer;
  previewIv: Buffer;
  previewHash: string;
};

const storedAction = async (
  overrides: Partial<StoredAction> = {},
): Promise<StoredAction> => {
  const encrypted = await encryptContent(
    organizationId,
    JSON.stringify(preview),
  );
  return {
    kind: "email.send",
    status: "pending",
    expired: false,
    previewEncrypted: encrypted.ciphertext,
    previewIv: encrypted.iv,
    previewHash,
    ...overrides,
  };
};

const setup = ({
  action,
  executor,
  confirmHash = previewHash,
  claimSucceeds = true,
  settlementFails = false,
}: {
  action: StoredAction | undefined;
  executor?: OutboundActionExecutor;
  confirmHash?: string;
  /** Whether the conditional `pending -> sending` update matches a row. */
  claimSucceeds?: boolean;
  settlementFails?: boolean;
}) => {
  const updates: unknown[] = [];
  const audits: unknown[] = [];
  const executed: unknown[] = [];
  const statements: string[] = [];
  const dialect = new PgDialect();
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => (action ? [action] : []),
    execute: async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      if (query.sql.includes("FOR UPDATE")) {
        return action ? [{ id: actionId }] : [];
      }
      const assignments = query.sql.split("SET").at(1)?.split("WHERE").at(0);
      expect(assignments).toBeDefined();
      const update = Object.fromEntries(
        Object.entries(getColumns(outboundActions)).flatMap(([key, column]) => {
          const parameter = assignments
            ?.match(new RegExp(`"${column.name}" = \\$(\\d+)`, "u"))
            ?.at(1);
          return parameter === undefined
            ? []
            : [[key, query.params.at(Number(parameter) - 1)]];
        }),
      );
      updates.push(update);
      statements.push(
        query.sql
          .replace(/\$(\d+)/gu, (_, parameter: string) =>
            JSON.stringify(query.params.at(Number(parameter) - 1)),
          )
          .replace(/\s+/gu, " ")
          .trim(),
      );
      const isClaim = query.params.includes("pending");
      return [{ count: isClaim && !claimSucceeds ? 0 : 1 }];
    },
  };
  const recordingExecutor: OutboundActionExecutor | undefined =
    executor === undefined
      ? undefined
      : async (context) => {
          executed.push(context.preview);
          return await executor(context);
        };
  const handler = createConfirmOutboundActionHandler({
    "email.send": recordingExecutor,
  });
  type Context = Parameters<typeof handler.handler>[0];
  const context = asTestRaw<Context>({
    params: { actionId },
    body: { previewHash: confirmHash },
    safeDb: async (operation: (tx: unknown) => unknown) => {
      if (settlementFails && executed.length > 0) {
        return Result.err(new TypeError("settlement unavailable"));
      }
      return Result.ok(await operation(chain));
    },
    session: { activeOrganizationId: organizationId },
    user: { id: toSafeId<"user">("user_1") },
    memberRole: sessionMemberRole("member"),
    recordAuditEvent: async (_tx: unknown, value: unknown) => {
      audits.push(value);
    },
    request: new Request(
      `https://api.example.test/v1/outbound-actions/${actionId}/confirm`,
      { method: "POST" },
    ),
    route: "/v1/outbound-actions/:actionId/confirm",
  });
  return { audits, context, executed, handler, statements, updates };
};

const sends: OutboundActionExecutor = async () =>
  Result.ok({ providerMessageId: "provider-message-1" });

test("a confirm of the exact preview sends it once with the stored content", async () => {
  const fixture = setup({ action: await storedAction(), executor: sends });
  expect(await fixture.handler.handler(fixture.context)).toEqual({
    status: "sent",
    providerMessageId: "provider-message-1",
    failureCode: null,
  });
  expect(fixture.executed).toEqual([preview]);
  expect(fixture.updates).toEqual([
    expect.objectContaining({ status: "sending" }),
    expect.objectContaining({
      status: "sent",
      providerMessageId: "provider-message-1",
    }),
  ]);
  for (const statement of fixture.statements) {
    expect(statement).toContain(`"outbound_actions"."id" = "${actionId}"`);
    expect(statement).toContain(
      `"outbound_actions"."organization_id" = "${organizationId}"`,
    );
    expect(statement).toContain('"outbound_actions"."user_id" = "user_1"');
  }
  const claim = fixture.statements.find((statement) =>
    statement.includes('"outbound_actions"."status" IN ("pending")'),
  );
  expect(claim).toBeDefined();
  expect(claim).toContain(
    `"outbound_actions"."preview_hash" = "${previewHash}"`,
  );
  expect(claim).toContain(
    '"outbound_actions"."expires_at" > clock_timestamp()',
  );
  expect(
    fixture.statements.find((statement) =>
      statement.includes('SET "status" = "sent"'),
    ),
  ).toContain('"outbound_actions"."status" IN ("sending")');
  expect(fixture.audits).toEqual([
    expect.objectContaining({
      resourceType: "outbound_action",
      metadata: expect.objectContaining({ operation: "confirm" }),
    }),
    expect.objectContaining({
      metadata: expect.objectContaining({ operation: "sent" }),
    }),
  ]);
});

test("a settlement failure preserves the provider outcome without sending again", async () => {
  for (const executor of [
    sends,
    async () => Result.err({ failureCode: "recipient_rejected" }),
  ]) {
    const fixture = setup({
      action: await storedAction(),
      executor,
      settlementFails: true,
    });
    const result = await fixture.handler.handler(fixture.context);
    expect(result).toEqual(
      executor === sends
        ? {
            status: "sent",
            providerMessageId: "provider-message-1",
            failureCode: null,
          }
        : {
            status: "failed",
            providerMessageId: null,
            failureCode: "recipient_rejected",
          },
    );
    expect(fixture.executed).toEqual([preview]);
    expect(fixture.updates).toEqual([
      expect.objectContaining({ status: "sending" }),
    ]);
  }
});

test("an interrupted provider call stays sending with an unknown outcome, never failed", async () => {
  const fixture = setup({
    action: await storedAction(),
    executor: async () => {
      throw new TypeError("connection reset after the request was sent");
    },
  });
  expect(await fixture.handler.handler(fixture.context)).toEqual({
    status: "sending",
    providerMessageId: null,
    failureCode: OUTBOUND_FAILURE_OUTCOME_UNKNOWN,
  });
  expect(fixture.executed).toEqual([preview]);
  expect(fixture.updates).toEqual([
    expect.objectContaining({ status: "sending" }),
    expect.objectContaining({
      status: "sending",
      providerMessageId: null,
      failureCode: OUTBOUND_FAILURE_OUTCOME_UNKNOWN,
      completedAt: null,
    }),
  ]);
});

test("a confirm bound to another preview sends nothing", async () => {
  const fixture = setup({
    action: await storedAction(),
    executor: sends,
    confirmHash: "f".repeat(64),
  });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.executed).toEqual([]);
  expect(fixture.updates).toEqual([]);
});

test("an action that is not pending is never sent again", async () => {
  for (const status of ["sending", "sent", "failed", "discarded", "expired"]) {
    const fixture = setup({
      action: await storedAction({ status }),
      executor: sends,
    });
    expect(await fixture.handler.handler(fixture.context)).toMatchObject({
      code: 409,
    });
    expect(fixture.executed).toEqual([]);
  }
});

test("an expired preview is not sent", async () => {
  const fixture = setup({
    action: await storedAction({ expired: true }),
    executor: sends,
  });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.executed).toEqual([]);
  expect(fixture.updates).toEqual([]);
});

test("an action that expires between the read and the claim is not sent", async () => {
  // Unexpired when read; the claim's database-clock expiry check then matches
  // no row.
  const fixture = setup({
    action: await storedAction(),
    executor: sends,
    claimSucceeds: false,
  });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.executed).toEqual([]);
});

test("a confirm that loses the claim to a concurrent one sends nothing", async () => {
  const fixture = setup({
    action: await storedAction(),
    executor: sends,
    claimSucceeds: false,
  });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.executed).toEqual([]);
  expect(fixture.audits).toEqual([]);
});

test("a stored preview that no longer matches its hash is refused", async () => {
  const tampered = await encryptContent(
    organizationId,
    JSON.stringify({ ...preview, to: [{ address: "attacker@example.test" }] }),
  );
  const fixture = setup({
    action: await storedAction({
      previewEncrypted: tampered.ciphertext,
      previewIv: tampered.iv,
    }),
    executor: sends,
  });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 500,
  });
  expect(fixture.executed).toEqual([]);
});

test("a kind without a provider cannot be confirmed", async () => {
  const fixture = setup({ action: await storedAction() });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.updates).toEqual([]);
});

test("a provider refusal settles the action as failed with its code", async () => {
  const fixture = setup({
    action: await storedAction(),
    executor: async () => Result.err({ failureCode: "recipient_rejected" }),
  });
  expect(await fixture.handler.handler(fixture.context)).toEqual({
    status: "failed",
    providerMessageId: null,
    failureCode: "recipient_rejected",
  });
});

test("another user's or a missing action is not found", async () => {
  const fixture = setup({ action: undefined, executor: sends });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 404,
  });
  expect(fixture.executed).toEqual([]);
});
