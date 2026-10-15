import { Result } from "better-result";
import { expect, test } from "bun:test";

import type { OutboundEmailPreview } from "@stll/api-contract/outbound-action";

import { createConfirmOutboundActionHandler } from "@/api/handlers/outbound-actions/confirm";
import { toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import type { OutboundActionExecutor } from "@/api/lib/outbound-actions/executors";
import { outboundPreviewHash } from "@/api/lib/outbound-actions/preview";
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
  expiresAt: Date;
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
    expiresAt: new Date(Date.now() + 60_000),
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
}: {
  action: StoredAction | undefined;
  executor?: OutboundActionExecutor;
  confirmHash?: string;
  /** Whether the conditional `pending -> sending` update matches a row. */
  claimSucceeds?: boolean;
}) => {
  const updates: unknown[] = [];
  const audits: unknown[] = [];
  const executed: unknown[] = [];
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => (action ? [action] : []),
    update: () => ({
      set: (value: unknown) => ({
        where: () => {
          updates.push(value);
          return Object.assign(Promise.resolve(), {
            returning: async () => (claimSucceeds ? [{ id: actionId }] : []),
          });
        },
      }),
    }),
  };
  const recordingExecutor: OutboundActionExecutor | undefined =
    executor === undefined
      ? undefined
      : async (context) => {
          executed.push(context.preview);
          return await executor(context);
        };
  const handler = createConfirmOutboundActionHandler(
    recordingExecutor === undefined ? {} : { "email.send": recordingExecutor },
  );
  type Context = Parameters<typeof handler.handler>[0];
  const context = asTestRaw<Context>({
    params: { actionId },
    body: { previewHash: confirmHash },
    safeDb: async (operation: (tx: unknown) => unknown) =>
      Result.ok(await operation(chain)),
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
  return { audits, context, executed, handler, updates };
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
    action: await storedAction({ expiresAt: new Date(Date.now() - 1) }),
    executor: sends,
  });
  expect(await fixture.handler.handler(fixture.context)).toMatchObject({
    code: 409,
  });
  expect(fixture.executed).toEqual([]);
  expect(fixture.updates).toEqual([]);
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
