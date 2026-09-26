import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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
import { createSafeId } from "@/api/lib/branded-types";
import { generateInboundAddressToken } from "@/api/lib/inbound-mail/address";
import type { MailAuthentication } from "@/api/lib/inbound-mail/authentication";
import type {
  InboundDeliveryStore,
  PersistInboundDeliveryOptions,
} from "@/api/lib/inbound-mail/ingest";
import { createInboundMailStore } from "@/api/lib/inbound-mail/store";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
} from "@/api/tests/security/test-utils";

const orgA = mintAuthProviderId<"organization">();
const orgB = mintAuthProviderId<"organization">();
const memberA = mintAuthProviderId<"user">();
const unverifiedA = mintAuthProviderId<"user">();
const memberB = mintAuthProviderId<"user">();
const adminA = mintAuthProviderId<"user">();
const wsA1 = createSafeId<"workspace">();
const wsA2 = createSafeId<"workspace">();
const wsB1 = createSafeId<"workspace">();
const memberAWorkspaceId = createSafeId<"workspaceMember">();
const tokenA1 = generateInboundAddressToken();
const tokenA2 = generateInboundAddressToken();
const tokenB1 = generateInboundAddressToken();
const matterMailboxId = createSafeId<"correspondenceAllowedSender">();
const organizationMailboxId = createSafeId<"correspondenceAllowedSender">();
const foreignMailboxId = createSafeId<"correspondenceAllowedSender">();
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
      authentication: {
        spf: "pass",
        dkim: "none",
        dmarc: "pass",
        alignedIdentifier: domain,
      },
    },
  };
};

let db: TestDatabase;
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
  await persist({
    token,
    deliveryKey,
    receivedAt,
    delivery: candidate(sender),
  });

beforeAll(async () => {
  db = await getTestDb();
  await db.insert(user).values([
    {
      id: memberA,
      name: "Member A",
      email: "member@example.test",
      emailVerified: true,
    },
    { id: unverifiedA, name: "Unverified A", email: "unverified@example.test" },
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
  ]);
  await db.insert(correspondenceAllowedSenderMatters).values({
    id: createSafeId<"correspondenceAllowedSenderMatter">(),
    organizationId: orgA,
    workspaceId: wsA1,
    allowedSenderId: matterMailboxId,
  });
  filings = [];
  persist = createInboundMailStore({
    database: db,
    fileCandidate: async ({ workspaceId, organizationId, filer }) => {
      filings.push({ workspaceId, organizationId, filer });
      return { status: "filed", correspondenceId };
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

afterAll(async () => {
  await db.delete(organization).where(inArray(organization.id, [orgA, orgB]));
  await db
    .delete(user)
    .where(inArray(user.id, [memberA, unverifiedA, memberB, adminA]));
  await releaseTestDb();
});

describe("inbound delivery store", () => {
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

  test("organization-scoped shared mailbox files across matters until revoked", async () => {
    for (const token of [tokenA1, tokenA2]) {
      expect(
        await deliver({ sender: "shared-org@example.test", token }),
      ).toMatchObject({ status: "filed" });
    }
    expect(filings.map(({ workspaceId }) => workspaceId)).toEqual([wsA1, wsA2]);
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
});
