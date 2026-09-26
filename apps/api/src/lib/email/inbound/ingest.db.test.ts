import { Result } from "better-result";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

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
import { generateInboundAddressToken } from "@/api/lib/email/inbound/address";
import type { MailVerifier } from "@/api/lib/email/inbound/authentication";
import {
  ingestInboundMail,
  InboundPersistenceError,
} from "@/api/lib/email/inbound/ingest";
import { parseInboundMessage } from "@/api/lib/email/inbound/message";
import { createInboundMailPersistence } from "@/api/lib/email/inbound/persistence";
import {
  receiveSesInboundMail,
  SesInboundError,
} from "@/api/lib/email/inbound/ses";
import {
  openGatedTestDatabase,
  type GatedTestDb,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

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
let db: GatedTestDb;
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

if (!databaseUrl || !runPostgresTests) {
  describe.skip("inbound mail persisted under forced RLS", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("inbound mail persisted under forced RLS", () => {
    const gated = openGatedTestDatabase(databaseUrl);
    db = gated.db;
    gated.cleanUp(async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      for (const id of [memberId, colleagueId, adminId]) {
        await db.delete(user).where(eq(user.id, id));
      }
    });

    beforeAll(async () => {
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
        {
          id: workspaceId,
          organizationId,
          name: "Matter",
          reference: "MAIL-1",
        },
        {
          id: otherWorkspaceId,
          organizationId,
          name: "Other matter",
          reference: "MAIL-2",
        },
      ]);
      await db.insert(workspaceMembers).values([
        {
          id: createSafeId<"workspaceMember">(),
          workspaceId,
          userId: memberId,
        },
        {
          id: createSafeId<"workspaceMember">(),
          workspaceId,
          userId: colleagueId,
        },
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
    test("oversized provider deliveries acknowledge only after replay-safe token-scoped drops", async () => {
      const persist = createInboundMailPersistence({
        database: db,
        scopedDbForMatter: (scope) =>
          createScopedDb(
            db,
            [scope.workspaceId],
            scope.organizationId,
            scope.userId,
          ),
      });
      const event = {
        notificationType: "Received",
        mail: {
          messageId: "oversized-delivery",
          source: "member@example.test",
          timestamp: receivedAt,
        },
        receipt: {
          recipients: [
            `${token}@inbound.example.test`,
            `${token}@inbound.example.test`,
          ],
          action: {
            type: "S3",
            bucketName: "inbound-bucket",
            objectKey: "mail/oversized-delivery",
          },
          spfVerdict: { status: "PASS" },
          dkimVerdict: { status: "PASS" },
          dmarcVerdict: { status: "PASS" },
          virusVerdict: { status: "PASS" },
        },
      };
      const options = {
        event,
        inboundDomain: "inbound.example.test",
        bucket: "inbound-bucket",
        keyPrefix: "mail/",
        readObject: async () =>
          Result.err(
            new SesInboundError({
              message: "Inbound message exceeds size limit",
              reason: "message-too-large",
            }),
          ),
        persist,
      };
      const uncommitted = await receiveSesInboundMail({
        ...options,
        persist: async () =>
          Result.err(
            new InboundPersistenceError({
              message: "Injected persistence outage",
            }),
          ),
      });
      expect(uncommitted.isErr()).toBe(true);
      if (uncommitted.isErr()) {
        expect(uncommitted.error.reason).toBe("persistence-unavailable");
      }
      expect(await drops()).toHaveLength(0);
      for (let replay = 0; replay < 2; replay += 1) {
        const result = await receiveSesInboundMail(options);
        expect(result.isOk() && result.value).toEqual([
          { status: "dropped", reason: "message_too_large" },
        ]);
      }
      expect(await drops()).toMatchObject([
        { workspaceId, reason: "message_too_large", senderAddress: "" },
      ]);
      expect(await drops()).toHaveLength(1);
      expect(await records()).toHaveLength(0);
      const unknown = await receiveSesInboundMail({
        ...options,
        event: {
          ...event,
          receipt: {
            ...event.receipt,
            recipients: [
              `${generateInboundAddressToken()}@inbound.example.test`,
            ],
          },
        },
      });
      expect(unknown.isOk() && unknown.value).toEqual([
        { status: "dropped", reason: "unknown_recipient" },
      ]);
      expect(await drops()).toHaveLength(1);
      const other = await receiveSesInboundMail({
        ...options,
        event: {
          ...event,
          receipt: {
            ...event.receipt,
            recipients: [`${otherToken}@inbound.example.test`],
          },
        },
      });
      expect(other.isOk() && other.value).toEqual([
        { status: "dropped", reason: "message_too_large" },
      ]);
      expect((await drops()).map((row) => row.workspaceId).toSorted()).toEqual(
        [workspaceId, otherWorkspaceId].toSorted(),
      );
    });

    test("member CC files an outgoing record with user provenance", async () => {
      const result = await deliver(await fixture("member-cc.eml"));
      expect(result.isOk() && result.value).toMatchObject([
        { status: "filed" },
      ]);
      expect(await records()).toMatchObject([
        {
          workspaceId,
          direction: "out",
          intake: "direct",
          authenticatedSenderAddress: "member@example.test",
          originalSignature: null,
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

    test("an invalid Date header files with unknown sent time and replays without retrying forever", async () => {
      const raw = encode(
        decode(await fixture("member-cc.eml")).replace(
          /^Date:.*$/mu,
          "Date: not-a-date",
        ),
      );
      const first = await deliver(raw);
      const replay = await deliver(raw);
      expect(first.isOk() && first.value).toMatchObject([{ status: "filed" }]);
      expect(replay.isOk() && replay.value).toMatchObject([
        { status: "duplicate" },
      ]);
      expect(await records()).toMatchObject([
        { sentAt: null, intake: "direct" },
      ]);
      expect(await drops()).toHaveLength(0);
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
        {
          senderAddress: "outsider@outside.test",
          reason: "unauthorized_sender",
        },
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
          intake: "forwarded_attachment",
          authenticatedSenderAddress: "member@example.test",
          originalSignature: { status: "unverified" },
          from: { address: "author@outside.test" },
          bodyText: "Original body.",
        },
      ]);
      expect(
        (await filers()).map(({ filedByUserId }) => filedByUserId).toSorted(),
      ).toEqual([colleagueId, memberId].toSorted());
    });

    test("a fabricated inline original remains asserted content beside its authenticated delivery", async () => {
      const forged = encode(
        decode(await fixture("inline-forward-cs.eml"))
          .replace(
            "Author <author@outside.test>",
            "Judge <judge@court.example>",
          )
          .replace("Original body.", "Fabricated order."),
      );
      const result = await deliver(forged);
      expect(result.isOk() && result.value).toMatchObject([
        { status: "filed" },
      ]);
      expect(await records()).toMatchObject([
        {
          intake: "forwarded_inline",
          from: { address: "judge@court.example" },
          bodyText: "Fabricated order.",
          originalSignature: { status: "unverified" },
          authenticatedSenderAddress: "member@example.test",
          alignedIdentifier: "example.test",
          dmarc: "pass",
        },
      ]);
      expect(await filers()).toMatchObject([{ filedByUserId: memberId }]);
    });

    test("direct mail and a matching asserted original keep distinct delivery provenance", async () => {
      const direct = encode(
        [
          "From: Member <member@example.test>",
          "To: Matter <matter@example.test>",
          "Subject: Same content",
          "Date: Sat, 26 Sep 2026 12:00:00 +0000",
          "Message-ID: <same-content@example.test>",
          "Content-Type: text/plain; charset=UTF-8",
          "",
          "Same content.",
        ].join("\r\n"),
      );
      const forwarded = encode(
        [
          "From: Colleague <colleague@example.test>",
          "To: Matter <matter@example.test>",
          "Subject: Fwd: Same content",
          'Content-Type: multipart/mixed; boundary="dedup"',
          "",
          "--dedup",
          "Content-Type: message/rfc822",
          "",
          decode(direct),
          "--dedup--",
          "",
        ].join("\r\n"),
      );
      const directParsed = (await parseInboundMessage(direct)).unwrap();
      const forwardedParsed = (await parseInboundMessage(forwarded)).unwrap();
      expect(forwardedParsed.forwardSource).toBe("attached");
      expect(forwardedParsed.message.messageId).toBe(
        directParsed.message.messageId,
      );
      expect(forwardedParsed.message.contentHash).toBe(
        directParsed.message.contentHash,
      );
      for (const raw of [direct, forwarded, direct, forwarded]) {
        expect((await deliver(raw)).isOk()).toBe(true);
      }
      expect((await records()).map(({ intake }) => intake).toSorted()).toEqual([
        "direct",
        "forwarded_attachment",
      ]);
      expect(await filers()).toHaveLength(2);
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
}
