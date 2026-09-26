import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";

import type { ParsedCorrespondence } from "@stll/api-contract/correspondence";

import type { SafeDb } from "@/api/db/safe-db";
import { correspondenceAllowedSenders } from "@/api/db/schema";
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

describe("matter correspondence", () => {
  test("the migration forces RLS on every new table", () => {
    expect(createdTables.length).toBeGreaterThan(0);
    expect(forcedTables.toSorted()).toEqual(createdTables.toSorted());
  });

  test("deduplicates a filed message, exposes it through matter routes, and enforces mailbox scope and revocation", async () => {
    const safeDb = safeDbFor(ids.userA1, ids.wsA1);
    const parsed: ParsedCorrespondence = {
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
      authentication: {
        spf: "pass",
        dkim: "none",
        dmarc: "pass",
        alignedIdentifier: "example.test",
      },
    };
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
          authentication: { ...parsed.authentication, dmarc: "fail" },
        },
      }),
    ).toEqual({ type: "invalid_authentication" });
    const noMatterAccess = await createCorrespondence({
      ...options,
      safeDb: safeDbFor(ids.userA2, ids.wsA1),
      filer: { type: "user", userId: ids.userA2 },
      parsed: { ...parsed, messageId: `<${Bun.randomUUIDv7()}@example.test>` },
    });
    expect(noMatterAccess.type).toBe("error");

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
    const list = await listCorrespondence.handler(
      handlerContext<Parameters<typeof listCorrespondence.handler>[0]>({
        ...common,
        query: {},
      }),
    );
    expect(list.items.map(({ id }) => id)).toContain(first.id);
    const detail = await getCorrespondence.handler(
      handlerContext<Parameters<typeof getCorrespondence.handler>[0]>({
        ...common,
        params: { correspondenceId: first.id },
      }),
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
    const attachmentDetail = await getCorrespondence.handler(
      handlerContext<Parameters<typeof getCorrespondence.handler>[0]>({
        ...common,
        params: { correspondenceId: attached.id },
      }),
    );
    expect(attachmentDetail.attachments).toMatchObject([
      { entityId: ids.entityA1, filename: "evidence.pdf" },
    ]);
    const updated = await updateCorrespondence.handler(
      handlerContext<Parameters<typeof updateCorrespondence.handler>[0]>({
        ...common,
        body: { handlingState: "handled", assigneeId: ids.userA1 },
        params: { correspondenceId: first.id },
      }),
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
    const approved = await createAllowedSender.handler(
      handlerContext<Parameters<typeof createAllowedSender.handler>[0]>({
        ...admin,
        body: {
          address: "office@example.test",
          scope: "matters",
          matterIds: [ids.wsA1],
        },
      }),
    );
    expect(approved.scope).toBe("matters");
    const senderId = approved.id;
    const allowedList = await listAllowedSenders.handler(
      handlerContext<Parameters<typeof listAllowedSenders.handler>[0]>({
        ...admin,
        query: {},
      }),
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
    const mailboxDetail = await getCorrespondence.handler(
      handlerContext<Parameters<typeof getCorrespondence.handler>[0]>({
        ...common,
        params: { correspondenceId: first.id },
      }),
    );
    expect(mailboxDetail.filers).toContainEqual(
      expect.objectContaining({
        type: "shared_mailbox",
        allowedSenderId: senderId,
        approvedBy: ids.userAdmin,
      }),
    );

    const removedScope = await removeAllowedSenderMatter.handler(
      handlerContext<Parameters<typeof removeAllowedSenderMatter.handler>[0]>({
        ...admin,
        body: { matterId: ids.wsA1 },
        params: { senderId },
      }),
    );
    expect(removedScope).toEqual({ removed: true });
    const outOfScope = await createCorrespondence({
      ...options,
      filer: { type: "shared_mailbox", allowedSenderId: senderId },
      parsed: { ...parsed, messageId: `<${Bun.randomUUIDv7()}@example.test>` },
    });
    expect(outOfScope.type).toBe("error");

    const addedScope = await addAllowedSenderMatter.handler(
      handlerContext<Parameters<typeof addAllowedSenderMatter.handler>[0]>({
        ...admin,
        body: { matterId: ids.wsA1 },
        params: { senderId },
      }),
    );
    expect(addedScope).toEqual({ added: true });
    const revokedApproval = await revokeAllowedSender.handler(
      handlerContext<Parameters<typeof revokeAllowedSender.handler>[0]>({
        ...admin,
        params: { senderId },
      }),
    );
    expect(revokedApproval).toEqual({ id: senderId, revoked: true });
    const revoked = await createCorrespondence({
      ...options,
      filer: { type: "shared_mailbox", allowedSenderId: senderId },
      parsed: { ...parsed, messageId: `<${Bun.randomUUIDv7()}@example.test>` },
    });
    expect(revoked.type).toBe("error");
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
      const first = await createMatterInboundAddress.handler(
        handlerContext<
          Parameters<typeof createMatterInboundAddress.handler>[0]
        >(common),
      );
      const second = await createMatterInboundAddress.handler(
        handlerContext<
          Parameters<typeof createMatterInboundAddress.handler>[0]
        >(common),
      );
      expect(first.address).not.toBe(second.address);
      const active = await getMatterInboundAddress.handler(
        handlerContext<Parameters<typeof getMatterInboundAddress.handler>[0]>(
          common,
        ),
      );
      expect(active.address).toBe(second.address);
      await revokeMatterInboundAddress.handler(
        handlerContext<
          Parameters<typeof revokeMatterInboundAddress.handler>[0]
        >(common),
      );
      const revoked = await getMatterInboundAddress.handler(
        handlerContext<Parameters<typeof getMatterInboundAddress.handler>[0]>(
          common,
        ),
      );
      expect(revoked.address).toBeNull();
    } finally {
      env.INBOUND_MAIL_DOMAIN = previousDomain;
    }
  });
});
