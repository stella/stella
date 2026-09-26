import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceAttachments,
  entities,
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
  correspondenceDropLogs,
  correspondenceFilers,
  matterInboundAddresses,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { generateInboundAddressToken } from "@/api/lib/inbound-mail/address";
import type { MailVerifier } from "@/api/lib/inbound-mail/authentication";
import { ingestInboundMail } from "@/api/lib/inbound-mail/ingest";
import { createInboundMailPersistence } from "@/api/lib/inbound-mail/persistence";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
} from "@/api/tests/security/test-utils";

const organizationId = mintAuthProviderId<"organization">();
const memberId = mintAuthProviderId<"user">();
const colleagueId = mintAuthProviderId<"user">();
const adminId = mintAuthProviderId<"user">();
const workspaceId = createSafeId<"workspace">();
const otherWorkspaceId = createSafeId<"workspace">();
const mailboxId = createSafeId<"correspondenceAllowedSender">();
const token = generateInboundAddressToken();
const otherToken = generateInboundAddressToken();
const receivedAt = "2026-09-26T12:00:00.000Z";
let db: TestDatabase;
const fixture = async (name: string) =>
  new Uint8Array(
    await Bun.file(new URL(`fixtures/${name}`, import.meta.url)).arrayBuffer(),
  );
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const verify: MailVerifier = async ({ fromAddress }) => {
  const domain = fromAddress.split("@").at(1) ?? "";
  return Result.ok({
    source: "provider",
    evidence: "identifiers",
    fromDomain: domain,
    spf: { result: "pass", domain, alignment: "strict" },
    dkim: [],
    dmarc: "pass",
  });
};
const deliver = async (
  raw: Uint8Array,
  recipientToken = token,
  verifier = verify,
) =>
  await ingestInboundMail({
    raw,
    envelope: {
      mailFrom: "member@example.test",
      recipients: [`${recipientToken}@inbound.example.test`],
      remoteIp: "192.0.2.1",
      helo: "mail.example.test",
    },
    receivedAt,
    inboundDomain: "inbound.example.test",
    verify: verifier,
    scan: "pass",
    persist: createInboundMailPersistence({
      database: db,
      scopedDbForMatter: (scope) =>
        createScopedDb(
          db,
          [scope.workspaceId],
          scope.organizationId,
          scope.userId,
        ),
    }),
  });
const records = async () =>
  await db
    .select()
    .from(correspondence)
    .where(eq(correspondence.organizationId, organizationId));
const filers = async () =>
  await db
    .select()
    .from(correspondenceFilers)
    .where(eq(correspondenceFilers.organizationId, organizationId));
const drops = async () =>
  await db
    .select()
    .from(correspondenceDropLogs)
    .where(eq(correspondenceDropLogs.organizationId, organizationId));

beforeAll(async () => {
  db = await getTestDb();
  for (const table of [
    "correspondence",
    "correspondence_filers",
    "correspondence_attachments",
    "matter_inbound_addresses",
    "correspondence_allowed_senders",
    "correspondence_allowed_sender_matters",
    "correspondence_drop_logs",
  ]) {
    await db.execute(
      sql.raw(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`),
    );
  }
  await db.insert(user).values([
    {
      id: memberId,
      name: "Member",
      email: "member@example.test",
      emailVerified: true,
    },
    {
      id: colleagueId,
      name: "Colleague",
      email: "colleague@example.test",
      emailVerified: true,
    },
    {
      id: adminId,
      name: "Admin",
      email: "admin@example.test",
      emailVerified: true,
    },
  ]);
  await db.insert(organization).values({
    id: organizationId,
    name: "Inbound integration",
    slug: `inbound-${organizationId}`,
    createdAt: new Date(),
  });
  await db.insert(member).values([
    {
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: memberId,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: colleagueId,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: adminId,
      role: "owner",
      createdAt: new Date(),
    },
  ]);
  await db.insert(workspaces).values([
    { id: workspaceId, organizationId, name: "Matter", reference: "MAIL-1" },
    {
      id: otherWorkspaceId,
      organizationId,
      name: "Other matter",
      reference: "MAIL-2",
    },
  ]);
  await db.insert(workspaceMembers).values([
    { id: createSafeId<"workspaceMember">(), workspaceId, userId: memberId },
    { id: createSafeId<"workspaceMember">(), workspaceId, userId: colleagueId },
  ]);
  await db.insert(matterInboundAddresses).values([
    {
      id: createSafeId<"matterInboundAddress">(),
      organizationId,
      workspaceId,
      token,
    },
    {
      id: createSafeId<"matterInboundAddress">(),
      organizationId,
      workspaceId: otherWorkspaceId,
      token: otherToken,
    },
  ]);
  await db.insert(correspondenceAllowedSenders).values({
    id: mailboxId,
    organizationId,
    address: "office@example.test",
    kind: "shared_mailbox",
    scope: "matters",
    approvedBy: adminId,
  });
  await db.insert(correspondenceAllowedSenderMatters).values({
    id: createSafeId<"correspondenceAllowedSenderMatter">(),
    organizationId,
    workspaceId,
    allowedSenderId: mailboxId,
  });
}, 60_000);

beforeEach(async () => {
  await db
    .delete(correspondenceDropLogs)
    .where(eq(correspondenceDropLogs.organizationId, organizationId));
  await db
    .delete(correspondence)
    .where(eq(correspondence.organizationId, organizationId));
  await db.delete(entities).where(eq(entities.workspaceId, workspaceId));
});
afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, organizationId));
  for (const id of [memberId, colleagueId, adminId]) {
    await db.delete(user).where(eq(user.id, id));
  }
  await releaseTestDb();
});

describe("inbound mail persisted under forced RLS", () => {
  test("member CC files an outgoing record with user provenance", async () => {
    const result = await deliver(await fixture("member-cc.eml"));
    expect(result.isOk() && result.value).toMatchObject([{ status: "filed" }]);
    expect(await records()).toMatchObject([
      {
        workspaceId,
        direction: "out",
        from: { address: "member@example.test" },
        subject: "Status update",
        dmarc: "pass",
        spf: "pass",
        handlingState: "new",
      },
    ]);
    expect(await filers()).toMatchObject([
      { filedByUserId: memberId, filedByAllowedSenderId: null },
    ]);
  });

  test("forged From and missing DMARC create only replay-safe drops", async () => {
    const forged = await fixture("forged-from.eml");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await deliver(forged)).isOk()).toBe(true);
    }
    expect(await drops()).toMatchObject([
      { senderAddress: "", reason: "malformed_message" },
    ]);
    const noDmarc: MailVerifier = async ({ fromAddress }) => {
      const domain = fromAddress.split("@").at(1) ?? "";
      return Result.ok({
        source: "provider",
        evidence: "identifiers",
        fromDomain: domain,
        spf: { result: "pass", domain, alignment: "strict" },
        dkim: [],
        dmarc: "none",
      });
    };
    expect(
      (await deliver(await fixture("member-cc.eml"), token, noDmarc)).isOk(),
    ).toBe(true);
    expect((await drops()).map(({ reason }) => reason).toSorted()).toEqual([
      "authentication_failed",
      "malformed_message",
    ]);
    expect(await records()).toHaveLength(0);
  });

  test("authenticated outsider reply is rejected without a record", async () => {
    const raw = encode(
      decode(await fixture("member-cc.eml")).replaceAll(
        "member@example.test",
        "outsider@outside.test",
      ),
    );
    const result = await deliver(raw);
    expect(result.isOk() && result.value).toEqual([
      { status: "dropped", reason: "unauthorized_sender" },
    ]);
    expect(await records()).toHaveLength(0);
    expect(await drops()).toMatchObject([
      { senderAddress: "outsider@outside.test", reason: "unauthorized_sender" },
    ]);
  });

  test("forwarded original converges to one record and two filers", async () => {
    const original = await fixture("attached-forward.eml");
    const colleague = encode(
      decode(original).replace(
        "Member <member@example.test>",
        "Colleague <colleague@example.test>",
      ),
    );
    expect(decode(colleague)).not.toBe(decode(original));
    for (const raw of [original, colleague, original, colleague]) {
      expect((await deliver(raw)).isOk()).toBe(true);
    }
    expect(await records()).toMatchObject([
      {
        direction: "in",
        from: { address: "author@outside.test" },
        bodyText: "Original body.",
      },
    ]);
    expect(
      (await filers()).map(({ filedByUserId }) => filedByUserId).toSorted(),
    ).toEqual([colleagueId, memberId].toSorted());
  });

  test("attachment retry links each ordinal once with real entity rows", async () => {
    const raw = encode(
      [
        "From: Member <member@example.test>",
        "To: Matter <matter@example.test>",
        "Subject: Two attachments",
        "Date: Sat, 26 Sep 2026 12:00:00 +0000",
        "Message-ID: <attachments@example.test>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="parts"',
        "",
        "--parts",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "Body.",
        "--parts",
        "Content-Type: text/plain; name=one.txt",
        'Content-Disposition: attachment; filename="one.txt"',
        "",
        "One",
        "--parts",
        "Content-Type: text/plain; name=two.txt",
        'Content-Disposition: attachment; filename="two.txt"',
        "",
        "Two",
        "--parts--",
        "",
      ].join("\r\n"),
    );
    let writes = 0;
    let failSecond = true;
    const persist = createInboundMailPersistence({
      database: db,
      scopedDbForMatter: (scope) =>
        createScopedDb(
          db,
          [scope.workspaceId],
          scope.organizationId,
          scope.userId,
        ),
      scanAttachment: async ({ bytes, declaredMimeType, fileName }) =>
        Result.ok(
          testScannedFile({
            bytes:
              bytes instanceof ArrayBuffer
                ? bytes
                : new Uint8Array(bytes).buffer,
            mimeType: declaredMimeType,
            path: fileName,
          }),
        ),
      createDocument: async ({
        scopedDb,
        workspaceId: documentWorkspaceId,
        fileName,
        afterCreate,
      }) => {
        writes += 1;
        if (failSecond && writes === 2) {
          throw new Error("injected document failure");
        }
        const document = {
          entityId: createSafeId<"entity">(),
          entityVersionId: createSafeId<"entityVersion">(),
          fieldId: createSafeId<"field">(),
          fileName,
        };
        await scopedDb(async (tx) => {
          await tx.insert(entities).values({
            id: document.entityId,
            workspaceId: documentWorkspaceId,
            name: fileName,
          });
          await afterCreate?.(tx, document);
        });
        return Result.ok(document);
      },
    });
    const ingest = async () =>
      await ingestInboundMail({
        raw,
        envelope: {
          mailFrom: "member@example.test",
          recipients: [`${token}@inbound.example.test`],
          remoteIp: "192.0.2.1",
          helo: "mail.example.test",
        },
        receivedAt,
        inboundDomain: "inbound.example.test",
        verify,
        scan: "pass",
        persist,
      });
    expect((await ingest()).isErr()).toBe(true);
    expect(await db.select().from(correspondenceAttachments)).toMatchObject([
      { ordinal: 0, filename: "two.txt" },
    ]);
    const reordered = encode(
      decode(raw).replace(
        '--parts\r\nContent-Type: text/plain; name=one.txt\r\nContent-Disposition: attachment; filename="one.txt"\r\n\r\nOne\r\n--parts\r\nContent-Type: text/plain; name=two.txt\r\nContent-Disposition: attachment; filename="two.txt"\r\n\r\nTwo',
        '--parts\r\nContent-Type: text/plain; name=two.txt\r\nContent-Disposition: attachment; filename="two.txt"\r\n\r\nTwo\r\n--parts\r\nContent-Type: text/plain; name=one.txt\r\nContent-Disposition: attachment; filename="one.txt"\r\n\r\nOne',
      ),
    );
    expect(decode(reordered)).not.toBe(decode(raw));
    failSecond = false;
    expect(
      (
        await ingestInboundMail({
          raw: reordered,
          envelope: {
            mailFrom: "member@example.test",
            recipients: [`${token}@inbound.example.test`],
            remoteIp: "192.0.2.1",
            helo: "mail.example.test",
          },
          receivedAt,
          inboundDomain: "inbound.example.test",
          verify,
          scan: "pass",
          persist,
        })
      ).isOk(),
    ).toBe(true);
    expect((await ingest()).isOk()).toBe(true);
    expect(
      (await db.select().from(correspondenceAttachments))
        .map(({ ordinal }) => ordinal)
        .toSorted(),
    ).toEqual([0, 1]);
    expect(
      await db
        .select()
        .from(entities)
        .where(eq(entities.workspaceId, workspaceId)),
    ).toHaveLength(2);
    expect(await records()).toHaveLength(1);
  });

  test("approved mailbox has mailbox provenance and is limited to its matter", async () => {
    const raw = encode(
      decode(await fixture("member-cc.eml")).replaceAll(
        "member@example.test",
        "office@example.test",
      ),
    );
    const allowed = await deliver(raw);
    expect(allowed.isOk() && allowed.value).toMatchObject([
      { status: "filed" },
    ]);
    expect(await filers()).toMatchObject([
      { filedByUserId: null, filedByAllowedSenderId: mailboxId },
    ]);
    const denied = await deliver(raw, otherToken);
    expect(denied.isOk() && denied.value).toEqual([
      { status: "dropped", reason: "unauthorized_sender" },
    ]);
    expect(await records()).toHaveLength(1);
    expect(await drops()).toMatchObject([
      { workspaceId: otherWorkspaceId, reason: "unauthorized_sender" },
    ]);
  });
});
