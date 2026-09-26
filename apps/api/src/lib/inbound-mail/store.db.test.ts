import { Result } from "better-result";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
  correspondenceDropLogs,
  matterInboundAddresses,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { generateInboundAddressToken } from "@/api/lib/inbound-mail/address";
import type { MailAuthentication } from "@/api/lib/inbound-mail/authentication";
import type {
  InboundDeliveryStore,
  PersistInboundDeliveryOptions,
} from "@/api/lib/inbound-mail/ingest";
import { InboundPersistenceError } from "@/api/lib/inbound-mail/ingest";
import { createInboundMailStore } from "@/api/lib/inbound-mail/store";
import {
  openGatedTestDatabase,
  type GatedTestDb,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const orgA = mintAuthProviderId<"organization">();
const orgB = mintAuthProviderId<"organization">();
const memberA = mintAuthProviderId<"user">();
const unverifiedA = mintAuthProviderId<"user">();
const memberB = mintAuthProviderId<"user">();
const adminA = mintAuthProviderId<"user">();
const aliasOwner = mintAuthProviderId<"user">();
const mailboxUser = mintAuthProviderId<"user">();
const wsA1 = createSafeId<"workspace">();
const wsA2 = createSafeId<"workspace">();
const wsB1 = createSafeId<"workspace">();
const memberAWorkspaceId = createSafeId<"workspaceMember">();
const aliasOwnerWorkspaceId = createSafeId<"workspaceMember">();
const aliasOwnerOrganizationMemberId = mintAuthProviderIdValue();
const tokenA1 = generateInboundAddressToken();
const tokenA2 = generateInboundAddressToken();
const tokenB1 = generateInboundAddressToken();
const matterMailboxId = createSafeId<"correspondenceAllowedSender">();
const organizationMailboxId = createSafeId<"correspondenceAllowedSender">();
const foreignMailboxId = createSafeId<"correspondenceAllowedSender">();
const aliasId = createSafeId<"correspondenceAllowedSender">();
const correspondenceId = createSafeId<"correspondence">();
const receivedAt = "2026-09-26T12:00:00.000Z";

type Candidate = Extract<
  PersistInboundDeliveryOptions["delivery"],
  { status: "candidate" }
>;

const candidate = (sender: string): Candidate => {
  const domain = sender.split("@").at(1) ?? "";
  const authentication = {
    source: "provider",
    evidence: "identifiers",
    fromDomain: domain,
    spf: { result: "pass", domain, alignment: "strict" },
    dkim: [],
    dmarc: "pass",
  } satisfies MailAuthentication;
  return {
    status: "candidate",
    sender,
    authentication,
    attachments: [],
    message: {
      direction: "out",
      channel: "email",
      messageId: "<message@example.test>",
      contentHash: "a".repeat(64),
      from: { address: sender, name: null },
      to: [{ address: "matter@example.test", name: null }],
      cc: [],
      subject: "Test message",
      sentAt: receivedAt,
      receivedAt,
      inReplyTo: null,
      references: [],
      bodyText: "Test body",
      bodyHtml: null,
      intake: "direct",
      originalSignature: null,
      authenticatedSender: {
        address: sender,
        spf: "pass",
        dkim: "none",
        dmarc: "pass",
        alignedIdentifier: domain,
      },
    },
  };
};

let db: GatedTestDb;
let persist: InboundDeliveryStore;
let filings: {
  workspaceId: string;
  organizationId: string;
  filer: unknown;
}[];

const deliver = async ({
  sender,
  token = tokenA1,
  deliveryKey = Bun.randomUUIDv7(),
}: {
  sender: string;
  token?: string;
  deliveryKey?: string;
}) =>
  (
    await persist({
      token,
      deliveryKey,
      receivedAt,
      delivery: candidate(sender),
    })
  ).unwrap();

if (!databaseUrl || !runPostgresTests) {
  describe.skip("inbound delivery store", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("inbound delivery store", () => {
    const gated = openGatedTestDatabase(databaseUrl);
    db = gated.db;
    gated.cleanUp(async () => {
      await db
        .delete(organization)
        .where(inArray(organization.id, [orgA, orgB]));
      await db
        .delete(user)
        .where(
          inArray(user.id, [
            memberA,
            unverifiedA,
            memberB,
            adminA,
            aliasOwner,
            mailboxUser,
          ]),
        );
    });

    beforeAll(async () => {
      await db.insert(user).values([
        {
          id: memberA,
          name: "Member A",
          email: "member@example.test",
          emailVerified: true,
        },
        {
          id: unverifiedA,
          name: "Unverified A",
          email: "unverified@example.test",
        },
        {
          id: memberB,
          name: "Member B",
          email: "member@foreign.test",
          emailVerified: true,
        },
        {
          id: adminA,
          name: "Admin A",
          email: "admin@example.test",
          emailVerified: true,
        },
        {
          id: aliasOwner,
          name: "Alias owner",
          email: "alias-owner@example.test",
          emailVerified: true,
        },
        {
          id: mailboxUser,
          name: "Mailbox user",
          email: "shared-matter@example.test",
          emailVerified: true,
        },
      ]);
      await db.insert(organization).values([
        {
          id: orgA,
          name: "Inbound A",
          slug: `inbound-a-${orgA}`,
          createdAt: new Date(),
        },
        {
          id: orgB,
          name: "Inbound B",
          slug: `inbound-b-${orgB}`,
          createdAt: new Date(),
        },
      ]);
      await db.insert(member).values([
        {
          id: mintAuthProviderIdValue(),
          organizationId: orgA,
          userId: memberA,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId: orgA,
          userId: unverifiedA,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId: orgA,
          userId: adminA,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId: orgB,
          userId: memberB,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: aliasOwnerOrganizationMemberId,
          organizationId: orgA,
          userId: aliasOwner,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId: orgA,
          userId: mailboxUser,
          role: "member",
          createdAt: new Date(),
        },
      ]);
      await db.insert(workspaces).values([
        { id: wsA1, organizationId: orgA, name: "Matter A1", reference: "A1" },
        { id: wsA2, organizationId: orgA, name: "Matter A2", reference: "A2" },
        { id: wsB1, organizationId: orgB, name: "Matter B1", reference: "B1" },
      ]);
      await db.insert(workspaceMembers).values([
        { id: memberAWorkspaceId, workspaceId: wsA1, userId: memberA },
        {
          id: createSafeId<"workspaceMember">(),
          workspaceId: wsA1,
          userId: unverifiedA,
        },
        {
          id: createSafeId<"workspaceMember">(),
          workspaceId: wsB1,
          userId: memberB,
        },
        { id: aliasOwnerWorkspaceId, workspaceId: wsA1, userId: aliasOwner },
        {
          id: createSafeId<"workspaceMember">(),
          workspaceId: wsA1,
          userId: mailboxUser,
        },
      ]);
      await db.insert(matterInboundAddresses).values([
        {
          id: createSafeId<"matterInboundAddress">(),
          organizationId: orgA,
          workspaceId: wsA1,
          token: tokenA1,
        },
        {
          id: createSafeId<"matterInboundAddress">(),
          organizationId: orgA,
          workspaceId: wsA2,
          token: tokenA2,
        },
        {
          id: createSafeId<"matterInboundAddress">(),
          organizationId: orgB,
          workspaceId: wsB1,
          token: tokenB1,
        },
      ]);
      await db.insert(correspondenceAllowedSenders).values([
        {
          id: matterMailboxId,
          organizationId: orgA,
          address: "shared-matter@example.test",
          kind: "shared_mailbox",
          scope: "matters",
          approvedBy: adminA,
        },
        {
          id: organizationMailboxId,
          organizationId: orgA,
          address: "shared-org@example.test",
          kind: "shared_mailbox",
          scope: "organization",
          approvedBy: adminA,
        },
        {
          id: foreignMailboxId,
          organizationId: orgB,
          address: "shared-foreign@foreign.test",
          kind: "shared_mailbox",
          scope: "organization",
          approvedBy: memberB,
        },
        {
          id: aliasId,
          organizationId: orgA,
          address: "verified-alias@example.test",
          kind: "verified_alias",
          scope: "matters",
          ownerUserId: aliasOwner,
        },
      ]);
      await db.insert(correspondenceAllowedSenderMatters).values([
        {
          id: createSafeId<"correspondenceAllowedSenderMatter">(),
          organizationId: orgA,
          workspaceId: wsA1,
          allowedSenderId: matterMailboxId,
        },
        {
          id: createSafeId<"correspondenceAllowedSenderMatter">(),
          organizationId: orgA,
          workspaceId: wsA1,
          allowedSenderId: aliasId,
        },
      ]);
      filings = [];
      persist = createInboundMailStore({
        database: db,
        fileCandidate: async ({ workspaceId, organizationId, filer }) => {
          filings.push({ workspaceId, organizationId, filer });
          return Result.ok({ status: "filed" as const, correspondenceId });
        },
      });
    }, 60_000);

    beforeEach(async () => {
      filings = [];
      await db
        .update(user)
        .set({ emailVerified: true })
        .where(eq(user.id, memberA));
      await db
        .update(matterInboundAddresses)
        .set({ revokedAt: null })
        .where(eq(matterInboundAddresses.token, tokenA1));
      await db
        .update(correspondenceAllowedSenders)
        .set({ revokedAt: null })
        .where(
          inArray(correspondenceAllowedSenders.id, [
            matterMailboxId,
            organizationMailboxId,
          ]),
        );
      await db
        .insert(workspaceMembers)
        .values({
          id: memberAWorkspaceId,
          workspaceId: wsA1,
          userId: memberA,
        })
        .onConflictDoNothing({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        });
    });

    test("a failed candidate rolls back rows written in its transaction", async () => {
      const insertedId = createSafeId<"correspondenceDropLog">();
      const failingStore = createInboundMailStore({
        database: db,
        fileCandidate: async ({ tx, workspaceId, organizationId }) => {
          await tx.insert(correspondenceDropLogs).values({
            id: insertedId,
            workspaceId,
            organizationId,
            senderAddress: "member@example.test",
            reason: "authentication_failed",
            receivedAt: new Date(receivedAt),
          });
          return Result.err(
            new InboundPersistenceError({ message: "Injected filing failure" }),
          );
        },
      });
      const result = await failingStore({
        token: tokenA1,
        deliveryKey: Bun.randomUUIDv7(),
        receivedAt,
        delivery: candidate("member@example.test"),
      });
      expect(
        await db
          .select({ id: correspondenceDropLogs.id })
          .from(correspondenceDropLogs)
          .where(eq(correspondenceDropLogs.id, insertedId)),
      ).toEqual([]);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toBe("Injected filing failure");
      }
    });

    test("files a verified current member with their user provenance", async () => {
      expect(await deliver({ sender: "member@example.test" })).toEqual({
        status: "filed",
        correspondenceId,
      });
      expect(filings).toEqual([
        {
          workspaceId: wsA1,
          organizationId: orgA,
          filer: { type: "user", userId: memberA, filedAt: receivedAt },
        },
      ]);
    });

    test.each(["outsider@outside.test", "unverified@example.test"])(
      "drops an outsider or unverified primary sender: %s",
      async (sender) => {
        expect(await deliver({ sender })).toEqual({
          status: "dropped",
          reason: "unauthorized_sender",
        });
        expect(filings).toHaveLength(0);
      },
    );

    test("rechecks matter membership when a previously filed delivery replays", async () => {
      const deliveryKey = Bun.randomUUIDv7();
      expect(
        await deliver({ sender: "member@example.test", deliveryKey }),
      ).toMatchObject({ status: "filed" });
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.id, memberAWorkspaceId));
      expect(
        await deliver({ sender: "member@example.test", deliveryKey }),
      ).toEqual({ status: "dropped", reason: "unauthorized_sender" });
      expect(filings).toHaveLength(1);
    });

    test("a revoked token cannot file, even for a current member", async () => {
      await db
        .update(matterInboundAddresses)
        .set({ revokedAt: new Date() })
        .where(eq(matterInboundAddresses.token, tokenA1));
      expect(await deliver({ sender: "member@example.test" })).toEqual({
        status: "dropped",
        reason: "revoked_address",
      });
      expect(filings).toHaveLength(0);
    });

    test("matter-scoped shared mailbox files only in an approved matter", async () => {
      expect(
        await deliver({ sender: "shared-matter@example.test" }),
      ).toMatchObject({ status: "filed" });
      expect(filings.at(0)?.filer).toEqual({
        type: "shared_mailbox",
        allowedSenderId: matterMailboxId,
        address: "shared-matter@example.test",
        approvedBy: adminA,
        filedAt: receivedAt,
      });
      expect(
        await deliver({ sender: "shared-matter@example.test", token: tokenA2 }),
      ).toEqual({ status: "dropped", reason: "unauthorized_sender" });
      expect(filings).toHaveLength(1);
    });

    test("a verified alias follows its owner's current organization and matter membership", async () => {
      const sender = "verified-alias@example.test";
      expect(await deliver({ sender })).toMatchObject({ status: "filed" });
      expect(filings.at(0)?.filer).toEqual({
        type: "user",
        userId: aliasOwner,
        filedAt: receivedAt,
      });
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.id, aliasOwnerWorkspaceId));
      expect(await deliver({ sender })).toEqual({
        status: "dropped",
        reason: "unauthorized_sender",
      });
      await db.insert(workspaceMembers).values({
        id: aliasOwnerWorkspaceId,
        workspaceId: wsA1,
        userId: aliasOwner,
      });
      await db
        .delete(member)
        .where(eq(member.id, aliasOwnerOrganizationMemberId));
      expect(await deliver({ sender })).toEqual({
        status: "dropped",
        reason: "unauthorized_sender",
      });
      expect(filings).toHaveLength(1);
    });

    test("an active shared-mailbox approval retains mailbox provenance over a matching primary user", async () => {
      const sender = "shared-matter@example.test";
      expect(await deliver({ sender })).toMatchObject({ status: "filed" });
      expect(filings.at(0)?.filer).toEqual({
        type: "shared_mailbox",
        allowedSenderId: matterMailboxId,
        address: sender,
        approvedBy: adminA,
        filedAt: receivedAt,
      });
      await db
        .update(correspondenceAllowedSenders)
        .set({ revokedAt: new Date() })
        .where(eq(correspondenceAllowedSenders.id, matterMailboxId));
      expect(await deliver({ sender })).toMatchObject({ status: "filed" });
      expect(filings.at(1)?.filer).toEqual({
        type: "user",
        userId: mailboxUser,
        filedAt: receivedAt,
      });
    });

    test("organization-scoped shared mailbox files across matters until revoked", async () => {
      for (const token of [tokenA1, tokenA2]) {
        expect(
          await deliver({ sender: "shared-org@example.test", token }),
        ).toMatchObject({ status: "filed" });
      }
      expect(filings.map(({ workspaceId }) => workspaceId)).toEqual([
        wsA1,
        wsA2,
      ]);
      await db
        .update(correspondenceAllowedSenders)
        .set({ revokedAt: new Date() })
        .where(eq(correspondenceAllowedSenders.id, organizationMailboxId));
      expect(await deliver({ sender: "shared-org@example.test" })).toEqual({
        status: "dropped",
        reason: "unauthorized_sender",
      });
      expect(filings).toHaveLength(2);
    });

    test("authorization stays in the token's tenant for primary and approved senders", async () => {
      for (const sender of [
        "member@foreign.test",
        "shared-foreign@foreign.test",
      ]) {
        expect(await deliver({ sender, token: tokenA1 })).toEqual({
          status: "dropped",
          reason: "unauthorized_sender",
        });
      }
      expect(
        await deliver({ sender: "member@foreign.test", token: tokenB1 }),
      ).toMatchObject({ status: "filed" });
      expect(filings).toEqual([
        {
          workspaceId: wsB1,
          organizationId: orgB,
          filer: { type: "user", userId: memberB, filedAt: receivedAt },
        },
      ]);
    });

    test("repeated terminal drops create one log row", async () => {
      const deliveryKey = Bun.randomUUIDv7();
      const sender = "terminal@outside.test";
      for (let index = 0; index < 2; index += 1) {
        expect(await deliver({ sender, deliveryKey })).toEqual({
          status: "dropped",
          reason: "unauthorized_sender",
        });
      }
      const rows = await db
        .select()
        .from(correspondenceDropLogs)
        .where(
          and(
            eq(correspondenceDropLogs.workspaceId, wsA1),
            eq(correspondenceDropLogs.senderAddress, sender),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows.at(0)?.reason).toBe("unauthorized_sender");
      expect(filings).toHaveLength(0);
    });

    test("drop logs are isolated by matter and organization under RLS", async () => {
      const senderA = "rls-a@outside.test";
      const senderB = "rls-b@outside.test";
      expect(await deliver({ sender: senderA, token: tokenA1 })).toMatchObject({
        status: "dropped",
      });
      expect(await deliver({ sender: senderB, token: tokenB1 })).toMatchObject({
        status: "dropped",
      });
      const readPair = async ({
        workspaceId,
        organizationId,
        userId,
      }: {
        workspaceId: SafeId<"workspace">;
        organizationId: SafeId<"organization">;
        userId: SafeId<"user">;
      }) =>
        await createScopedDb(
          db,
          [workspaceId],
          organizationId,
          userId,
        )(
          async (tx) =>
            await tx
              .select({ senderAddress: correspondenceDropLogs.senderAddress })
              .from(correspondenceDropLogs)
              .where(
                inArray(correspondenceDropLogs.senderAddress, [
                  senderA,
                  senderB,
                ]),
              ),
        );
      expect(
        await readPair({
          workspaceId: wsA1,
          organizationId: orgA,
          userId: memberA,
        }),
      ).toEqual([{ senderAddress: senderA }]);
      expect(
        await readPair({
          workspaceId: wsB1,
          organizationId: orgB,
          userId: memberB,
        }),
      ).toEqual([{ senderAddress: senderB }]);
    });
  });
}
