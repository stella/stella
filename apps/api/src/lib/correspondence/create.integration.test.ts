import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";
import { readFileSync } from "node:fs";

import type {
  CorrespondenceProvenance,
  ParsedCorrespondence,
} from "@stll/api-contract/correspondence";

import { member, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  correspondenceAllowedSenders,
  workspaceMembers,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import createAllowedSender from "@/api/handlers/organization-settings/correspondence/allowed-senders/create";
import revokeAllowedSender from "@/api/handlers/organization-settings/correspondence/allowed-senders/delete";
import listAllowedSenders from "@/api/handlers/organization-settings/correspondence/allowed-senders/list";
import addAllowedSenderMatter from "@/api/handlers/organization-settings/correspondence/allowed-senders/scope/add";
import removeAllowedSenderMatter from "@/api/handlers/organization-settings/correspondence/allowed-senders/scope/remove";
import createMatterInboundAddress from "@/api/handlers/workspaces/correspondence/address/create";
import revokeMatterInboundAddress from "@/api/handlers/workspaces/correspondence/address/delete";
import getMatterInboundAddress from "@/api/handlers/workspaces/correspondence/address/get";
import getCorrespondence from "@/api/handlers/workspaces/correspondence/get";
import listCorrespondence from "@/api/handlers/workspaces/correspondence/list";
import updateCorrespondence from "@/api/handlers/workspaces/correspondence/update";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createCorrespondence } from "@/api/lib/correspondence/create";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const migration = readFileSync(
  new URL(
    "../../../drizzle/20260926190000_correspondence_core/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);
const createdTables = [...migration.matchAll(/CREATE TABLE "([^"]+)"/gu)].map(
  ([, table]) => table,
);
const forcedTables = [
  ...migration.matchAll(/ALTER TABLE "([^"]+)" FORCE ROW LEVEL SECURITY/gu),
].map(([, table]) => table);

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  for (const table of createdTables) {
    await testDb.execute(
      sql.raw(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`),
    );
  }
});

afterAll(async () => {
  await releaseRlsFixture();
});

const safeDbFor = (userId: TestIds["userA1"], workspaceId: TestIds["wsA1"]) =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [workspaceId], ids.orgA, userId));

const recorderFor = (
  userId: TestIds["userA1"],
  workspaceId: TestIds["wsA1"] | null,
) =>
  createAuditRecorder({
    organizationId: ids.orgA,
    workspaceId,
    userId,
    request: new Request("https://api.example.test/v1/correspondence"),
    server: null,
  });

const handlerContext = <T>(value: unknown) => asTestRaw<T>(value);

type HandlerFailure = Extract<
  Awaited<ReturnType<typeof getCorrespondence.handler>>,
  { code: number }
>;

const expectSuccess = <T>(response: T | HandlerFailure): T => {
  expect(response).not.toBeInstanceOf(ElysiaCustomStatusResponse);
  if (response instanceof ElysiaCustomStatusResponse) {
    throw new TypeError(`Expected success, received status ${response.code}`);
  }
  return response;
};

const directProvenance = {
  intake: "direct",
  originalSignature: null,
  authenticatedSender: {
    address: "sender@example.test",
    spf: "pass",
    dkim: "none",
    dmarc: "pass",
    alignedIdentifier: "example.test",
  },
} satisfies CorrespondenceProvenance;

const parsedMessage = (provenance: CorrespondenceProvenance) =>
  ({
    direction: "in",
    channel: "email",
    messageId: `<${Bun.randomUUIDv7()}@example.test>`,
    contentHash: "a".repeat(64),
    from: { address: "sender@example.test", name: null },
    to: [{ address: "recipient@example.test", name: null }],
    cc: [],
    subject: "Test filing",
    sentAt: "2026-09-26T12:00:00.000Z",
    receivedAt: "2026-09-26T12:01:00.000Z",
    inReplyTo: null,
    references: [],
    bodyText: "Matter correspondence",
    bodyHtml: "<p>Matter correspondence</p><script>alert(1)</script>",
    ...provenance,
  }) satisfies ParsedCorrespondence;

const commonContext = () => ({
  safeDb: safeDbFor(ids.userA1, ids.wsA1),
  workspaceId: ids.wsA1,
  memberRole: { role: "owner" },
  request: new Request("https://api.example.test/v1/correspondence"),
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
  recordAuditEvent: recorderFor(ids.userA1, ids.wsA1),
});

const fileMessage = async (parsed: ParsedCorrespondence) => {
  const result = await createCorrespondence({
    safeDb: safeDbFor(ids.userA1, ids.wsA1),
    workspaceId: ids.wsA1,
    organizationId: ids.orgA,
    filer: { type: "user", userId: ids.userA1 },
    parsed,
    attachments: [],
    recordAuditEvent: recorderFor(ids.userA1, ids.wsA1),
  });
  expect(result.type).toBe("ok");
  if (result.type !== "ok") {
    throw new Error("Expected correspondence fixture");
  }
  return result;
};

describe("matter correspondence", () => {
  test("the migration forces RLS on every new table", () => {
    expect(createdTables.length).toBeGreaterThan(0);
    expect(forcedTables.toSorted()).toEqual(createdTables.toSorted());
  });

  test("deduplicates a filed message, exposes it through matter routes, and enforces mailbox scope and revocation", async () => {
    const safeDb = safeDbFor(ids.userA1, ids.wsA1);
    const parsed = parsedMessage(directProvenance);
    const options = {
      safeDb,
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      filer: { type: "user" as const, userId: ids.userA1 },
      parsed,
      attachments: [],
      recordAuditEvent: recorderFor(ids.userA1, ids.wsA1),
    };
    const first = await createCorrespondence(options);
    expect(first).toMatchObject({
      type: "ok",
      created: true,
      filerAdded: true,
    });
    if (first.type !== "ok") {
      throw new Error("Expected filed correspondence");
    }
    const duplicate = await createCorrespondence(options);
    expect(duplicate).toEqual({
      type: "ok",
      id: first.id,
      created: false,
      filerAdded: false,
    });
    expect(
      await createCorrespondence({
        ...options,
        parsed: {
          ...parsed,
          messageId: `<${Bun.randomUUIDv7()}@example.test>`,
          authenticatedSender: { ...parsed.authenticatedSender, dmarc: "fail" },
        },
      }),
    ).toEqual({ type: "invalid_authentication" });
    const noMatterAccess = await createCorrespondence({
      ...options,
      safeDb: safeDbFor(ids.userA2, ids.wsA1),
      filer: { type: "user", userId: ids.userA2 },
      parsed: { ...parsed, messageId: `<${Bun.randomUUIDv7()}@example.test>` },
    });
    expect(noMatterAccess).toMatchObject({
      type: "error",
      error: { status: 403, message: "Matter access required" },
    });

    const attached = await createCorrespondence({
      ...options,
      parsed: {
        ...parsed,
        messageId: `<${Bun.randomUUIDv7()}@example.test>`,
        contentHash: "b".repeat(64),
      },
      attachments: [
        {
          entityId: ids.entityA1,
          filename: "evidence.pdf",
          mediaType: "application/pdf",
          byteSize: 128,
          scanVerdict: "clean",
        },
      ],
    });
    expect(attached.type).toBe("ok");
    if (attached.type !== "ok") {
      throw new Error("Expected attachment filing");
    }

    const common = {
      safeDb,
      workspaceId: ids.wsA1,
      memberRole: { role: "owner" },
      request: new Request("https://api.example.test/v1/correspondence"),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      recordAuditEvent: recorderFor(ids.userA1, ids.wsA1),
    };
    const list = expectSuccess(
      await listCorrespondence.handler(
        handlerContext<Parameters<typeof listCorrespondence.handler>[0]>({
          ...common,
          query: {},
        }),
      ),
    );
    expect(list.items.map(({ id }) => id)).toContain(first.id);
    const detail = expectSuccess(
      await getCorrespondence.handler(
        handlerContext<Parameters<typeof getCorrespondence.handler>[0]>({
          ...common,
          params: { correspondenceId: first.id },
        }),
      ),
    );
    expect(detail.record.id).toBe(first.id);
    expect(detail.record.bodyHtml).not.toContain("<script>");
    expect(detail.filers).toMatchObject([{ type: "user", userId: ids.userA1 }]);
    const foreignRead = await getCorrespondence.handler(
      handlerContext<Parameters<typeof getCorrespondence.handler>[0]>({
        ...common,
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [ids.wsA1], ids.orgB, ids.userB1),
        ),
        session: { activeOrganizationId: ids.orgB },
        user: { id: ids.userB1 },
        params: { correspondenceId: first.id },
      }),
    );
    expect(foreignRead).toMatchObject({ code: 404 });
    const attachmentDetail = expectSuccess(
      await getCorrespondence.handler(
        handlerContext<Parameters<typeof getCorrespondence.handler>[0]>({
          ...common,
          params: { correspondenceId: attached.id },
        }),
      ),
    );
    expect(attachmentDetail.attachments).toMatchObject([
      { entityId: ids.entityA1, filename: "evidence.pdf" },
    ]);
    const updated = expectSuccess(
      await updateCorrespondence.handler(
        handlerContext<Parameters<typeof updateCorrespondence.handler>[0]>({
          ...common,
          body: { handlingState: "handled", assigneeId: ids.userA1 },
          params: { correspondenceId: first.id },
        }),
      ),
    );
    expect(updated.record.handlingState).toBe("handled");

    const admin = {
      safeDb: safeDbFor(ids.userAdmin, ids.wsA1),
      memberRole: { role: "owner" },
      request: new Request("https://api.example.test/v1/correspondence"),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
      recordAuditEvent: recorderFor(ids.userAdmin, null),
    };
    const approved = expectSuccess(
      await createAllowedSender.handler(
        handlerContext<Parameters<typeof createAllowedSender.handler>[0]>({
          ...admin,
          body: {
            address: "office@example.test",
            scope: "matters",
            matterIds: [ids.wsA1],
          },
        }),
      ),
    );
    expect(approved.scope).toBe("matters");
    const senderId = approved.id;
    const allowedList = expectSuccess(
      await listAllowedSenders.handler(
        handlerContext<Parameters<typeof listAllowedSenders.handler>[0]>({
          ...admin,
          query: {},
        }),
      ),
    );
    expect(
      allowedList.items.find(({ id }) => id === senderId)?.matterIds,
    ).toEqual([ids.wsA1]);
    const foreignSenders = await asTestRaw<SafeDb>(
      createSafeDb(testDb, [ids.wsA1], ids.orgB, ids.userB1),
    )(
      async (tx) =>
        await tx
          .select({ id: correspondenceAllowedSenders.id })
          .from(correspondenceAllowedSenders),
    );
    expect(foreignSenders.isOk()).toBe(true);
    if (foreignSenders.isOk()) {
      expect(foreignSenders.value.map(({ id }) => id)).not.toContain(senderId);
    }

    const mailboxFiling = await createCorrespondence({
      ...options,
      filer: { type: "shared_mailbox", allowedSenderId: senderId },
    });
    expect(mailboxFiling).toMatchObject({
      type: "ok",
      id: first.id,
      created: false,
      filerAdded: true,
    });
    const mailboxDetail = expectSuccess(
      await getCorrespondence.handler(
        handlerContext<Parameters<typeof getCorrespondence.handler>[0]>({
          ...common,
          params: { correspondenceId: first.id },
        }),
      ),
    );
    expect(mailboxDetail.filers).toContainEqual(
      expect.objectContaining({
        type: "shared_mailbox",
        allowedSenderId: senderId,
        approvedBy: ids.userAdmin,
      }),
    );

    const removedScope = expectSuccess(
      await removeAllowedSenderMatter.handler(
        handlerContext<Parameters<typeof removeAllowedSenderMatter.handler>[0]>(
          {
            ...admin,
            body: { matterId: ids.wsA1 },
            params: { senderId },
          },
        ),
      ),
    );
    expect(removedScope).toEqual({ removed: true });
    const outOfScope = await createCorrespondence({
      ...options,
      filer: { type: "shared_mailbox", allowedSenderId: senderId },
      parsed: { ...parsed, messageId: `<${Bun.randomUUIDv7()}@example.test>` },
    });
    expect(outOfScope).toMatchObject({
      type: "error",
      error: { status: 403, message: "Mailbox not approved for matter" },
    });

    const addedScope = expectSuccess(
      await addAllowedSenderMatter.handler(
        handlerContext<Parameters<typeof addAllowedSenderMatter.handler>[0]>({
          ...admin,
          body: { matterId: ids.wsA1 },
          params: { senderId },
        }),
      ),
    );
    expect(addedScope).toEqual({ added: true });
    const revokedApproval = expectSuccess(
      await revokeAllowedSender.handler(
        handlerContext<Parameters<typeof revokeAllowedSender.handler>[0]>({
          ...admin,
          params: { senderId },
        }),
      ),
    );
    expect(revokedApproval).toEqual({ id: senderId, revoked: true });
    const revoked = await createCorrespondence({
      ...options,
      filer: { type: "shared_mailbox", allowedSenderId: senderId },
      parsed: { ...parsed, messageId: `<${Bun.randomUUIDv7()}@example.test>` },
    });
    expect(revoked).toMatchObject({
      type: "error",
      error: { status: 403, message: "Mailbox approval required" },
    });
  });

  test("rotates and revokes the per-matter inbound address", async () => {
    const previousDomain = env.INBOUND_MAIL_DOMAIN;
    env.INBOUND_MAIL_DOMAIN = "inbound.example.test";
    try {
      const common = {
        safeDb: safeDbFor(ids.userA1, ids.wsA1),
        workspaceId: ids.wsA1,
        memberRole: { role: "owner" },
        request: new Request("https://api.example.test/v1/correspondence"),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        recordAuditEvent: recorderFor(ids.userA1, ids.wsA1),
      };
      const first = expectSuccess(
        await createMatterInboundAddress.handler(
          handlerContext<
            Parameters<typeof createMatterInboundAddress.handler>[0]
          >(common),
        ),
      );
      const second = expectSuccess(
        await createMatterInboundAddress.handler(
          handlerContext<
            Parameters<typeof createMatterInboundAddress.handler>[0]
          >(common),
        ),
      );
      expect(first.address).not.toBe(second.address);
      const active = expectSuccess(
        await getMatterInboundAddress.handler(
          handlerContext<Parameters<typeof getMatterInboundAddress.handler>[0]>(
            common,
          ),
        ),
      );
      expect(active.address).toBe(second.address);
      await revokeMatterInboundAddress.handler(
        handlerContext<
          Parameters<typeof revokeMatterInboundAddress.handler>[0]
        >(common),
      );
      const revoked = expectSuccess(
        await getMatterInboundAddress.handler(
          handlerContext<Parameters<typeof getMatterInboundAddress.handler>[0]>(
            common,
          ),
        ),
      );
      expect(revoked.address).toBeNull();
    } finally {
      env.INBOUND_MAIL_DOMAIN = previousDomain;
    }
  });
  test("keeps asserted originals separate from authenticated delivery and direct-message dedup", async () => {
    const authenticatedSender = {
      ...directProvenance.authenticatedSender,
      address: "forwarder@example.test",
    };
    const inline = parsedMessage({
      intake: "forwarded_inline",
      authenticatedSender,
      originalSignature: { status: "unverified" },
    });
    inline.from.address = "fabricated@outside.test";
    const first = await fileMessage(inline);
    const replay = await fileMessage(inline);
    expect(replay.id).toBe(first.id);
    const detail = expectSuccess(
      await getCorrespondence.handler(
        handlerContext<Parameters<typeof getCorrespondence.handler>[0]>({
          ...commonContext(),
          params: { correspondenceId: first.id },
        }),
      ),
    );
    expect(detail.record).toMatchObject({
      intake: "forwarded_inline",
      from: inline.from,
      authenticatedSender,
      originalSignature: { status: "unverified" },
    });
    expect(detail.record).not.toHaveProperty("authentication");
    const {
      intake: _intake,
      originalSignature: _originalSignature,
      authenticatedSender: _authenticatedSender,
      ...content
    } = inline;
    const direct = await fileMessage({ ...content, ...directProvenance });
    expect(direct.id).not.toBe(first.id);
    for (const originalSignature of [
      { status: "unverified" } as const,
      { status: "verified", domain: "outside.test" } as const,
    ]) {
      const attachment = await fileMessage(
        parsedMessage({
          intake: "forwarded_attachment",
          authenticatedSender,
          originalSignature,
        }),
      );
      const read = expectSuccess(
        await getCorrespondence.handler(
          handlerContext<Parameters<typeof getCorrespondence.handler>[0]>({
            ...commonContext(),
            params: { correspondenceId: attachment.id },
          }),
        ),
      );
      expect(read.record).toMatchObject({
        intake: "forwarded_attachment",
        authenticatedSender,
        originalSignature,
      });
    }
    const list = expectSuccess(
      await listCorrespondence.handler(
        handlerContext<Parameters<typeof listCorrespondence.handler>[0]>({
          ...commonContext(),
          query: {},
        }),
      ),
    );
    expect(list.items.find(({ id }) => id === first.id)).toMatchObject({
      intake: "forwarded_inline",
      authenticatedSender,
      originalSignature: { status: "unverified" },
    });
  });

  test("interleaved status and assignment edits preserve each other's supplied fields", async () => {
    const filed = await fileMessage(parsedMessage(directProvenance));
    const patch = (
      body: Parameters<typeof updateCorrespondence.handler>[0]["body"],
    ) =>
      updateCorrespondence.handler(
        handlerContext<Parameters<typeof updateCorrespondence.handler>[0]>({
          ...commonContext(),
          safeDb: safeDbFor(ids.userAdmin, ids.wsA1),
          user: { id: ids.userAdmin },
          recordAuditEvent: recorderFor(ids.userAdmin, ids.wsA1),
          params: { correspondenceId: filed.id },
          body,
        }),
      );
    expect(
      expectSuccess(await patch({ assigneeId: ids.userA1 })).record,
    ).toMatchObject({
      handlingState: "new",
      assigneeId: ids.userA1,
    });
    expect(
      expectSuccess(await patch({ handlingState: "handled" })).record,
    ).toMatchObject({
      handlingState: "handled",
      assigneeId: ids.userA1,
    });
    expect(
      expectSuccess(await patch({ assigneeId: null })).record,
    ).toMatchObject({
      handlingState: "handled",
      assigneeId: null,
    });
    expect(
      expectSuccess(await patch({ handlingState: "new" })).record,
    ).toMatchObject({
      handlingState: "new",
      assigneeId: null,
    });
    const departed = await testDb
      .delete(member)
      .where(
        and(eq(member.organizationId, ids.orgA), eq(member.userId, ids.userA1)),
      )
      .returning();
    try {
      // A stale workspace membership must not restore an offboarded assignee.
      expect(await patch({ assigneeId: ids.userA1 })).toMatchObject({
        code: 400,
      });
      expect(
        expectSuccess(await patch({ handlingState: "handled" })).record,
      ).toMatchObject({
        handlingState: "handled",
        assigneeId: null,
      });
    } finally {
      if (departed.length) {
        await testDb.insert(member).values(departed);
      }
    }
  });

  test.each(["schema", "migration"] as const)(
    "historical attribution survives membership removal under %s policies",
    async (policySource) => {
      if (policySource === "migration") {
        const statement = migration
          .split("--> statement-breakpoint")
          .find((part) =>
            part.includes(
              'CREATE POLICY "auth_user_correspondence_history_select"',
            ),
          );
        if (!statement) {
          throw new Error("Expected historical user policy migration");
        }
        await testDb.execute(
          sql`DROP POLICY auth_user_correspondence_history_select ON "user"`,
        );
        await testDb.execute(sql.raw(statement));
      }
      const filed = await fileMessage(parsedMessage(directProvenance));
      const [sender] = await testDb
        .insert(correspondenceAllowedSenders)
        .values({
          organizationId: ids.orgA,
          address: `history-${Bun.randomUUIDv7()}@example.test`,
          kind: "shared_mailbox",
          scope: "organization",
          approvedBy: ids.userAdmin,
        })
        .returning();
      if (!sender) {
        throw new Error("Expected mailbox fixture");
      }
      // Use the persisted identity to attach the second historical actor.
      const parsed = parsedMessage(directProvenance);
      const mailbox = await createCorrespondence({
        safeDb: safeDbFor(ids.userA1, ids.wsA1),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        filer: { type: "shared_mailbox", allowedSenderId: sender.id },
        parsed,
        attachments: [],
        recordAuditEvent: recorderFor(ids.userA1, ids.wsA1),
      });
      if (mailbox.type !== "ok") {
        throw new Error("Expected mailbox filing");
      }
      const [readerMembership] = await testDb
        .insert(workspaceMembers)
        .values({ workspaceId: ids.wsA1, userId: ids.userA2 })
        .returning();
      if (!readerMembership) {
        throw new Error("Expected reader membership");
      }
      const read = async (id: typeof filed.id) =>
        expectSuccess(
          await getCorrespondence.handler(
            handlerContext<Parameters<typeof getCorrespondence.handler>[0]>({
              ...commonContext(),
              safeDb: safeDbFor(ids.userA2, ids.wsA1),
              user: { id: ids.userA2 },
              params: { correspondenceId: id },
            }),
          ),
        );
      const original = await read(filed.id);
      const originalMailbox = await read(mailbox.id);
      const actor = original.filers.find((filer) => filer.type === "user");
      const approver = originalMailbox.filers.find(
        (filer) => filer.type === "shared_mailbox",
      );
      if (actor === undefined || approver === undefined) {
        throw new Error("Expected retained filer and mailbox approver");
      }
      expect(actor).toMatchObject({
        userStatus: "active",
        userName: expect.any(String),
      });
      expect(approver).toMatchObject({
        approvedByStatus: "active",
        approvedByName: expect.any(String),
      });
      const removedMemberships = await testDb
        .delete(member)
        .where(
          and(
            eq(member.organizationId, ids.orgA),
            eq(member.userId, ids.userAdmin),
          ),
        )
        .returning();
      const removedAssignments = await testDb
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ids.wsA1),
            eq(workspaceMembers.userId, ids.userA1),
          ),
        )
        .returning();
      try {
        expect((await read(filed.id)).filers).toContainEqual(actor);
        expect((await read(mailbox.id)).filers).toContainEqual(approver);
        const unrelatedMatter = await safeDbFor(
          ids.userA2,
          ids.wsA2,
        )((tx) =>
          tx
            .select({ id: user.id })
            .from(user)
            .where(eq(user.id, ids.userAdmin)),
        );
        expect(unrelatedMatter.isOk()).toBe(true);
        if (unrelatedMatter.isOk()) {
          expect(unrelatedMatter.value).toEqual([]);
        }
        const foreignOrganization = await asTestRaw<SafeDb>(
          createSafeDb(testDb, [ids.wsB1], ids.orgB, ids.userB1),
        )((tx) =>
          tx
            .select({ id: user.id })
            .from(user)
            .where(eq(user.id, ids.userAdmin)),
        );
        expect(foreignOrganization.isOk()).toBe(true);
        if (foreignOrganization.isOk()) {
          expect(foreignOrganization.value).toEqual([]);
        }
        await testDb
          .update(user)
          .set({ deletedAt: new Date() })
          .where(eq(user.id, ids.userA1));
        await testDb
          .update(user)
          .set({ deletedAt: new Date() })
          .where(eq(user.id, ids.userAdmin));
        expect((await read(filed.id)).filers).toContainEqual(
          expect.objectContaining({
            type: "user",
            userStatus: "deleted",
            userName: null,
          }),
        );
        expect((await read(mailbox.id)).filers).toContainEqual(
          expect.objectContaining({
            type: "shared_mailbox",
            approvedByStatus: "deleted",
            approvedByName: null,
          }),
        );
      } finally {
        await testDb
          .update(user)
          .set({ deletedAt: null })
          .where(eq(user.id, ids.userA1));
        await testDb
          .update(user)
          .set({ deletedAt: null })
          .where(eq(user.id, ids.userAdmin));
        await testDb
          .delete(workspaceMembers)
          .where(eq(workspaceMembers.id, readerMembership.id));
        if (removedMemberships.length) {
          await testDb.insert(member).values(removedMemberships);
        }
        if (removedAssignments.length) {
          await testDb.insert(workspaceMembers).values(removedAssignments);
        }
      }
    },
  );
});
