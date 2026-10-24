import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import type { DataBoxStatedEnvelope } from "@stll/api-contract/data-box";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { SafeDb } from "@/api/db/safe-db";
import { contacts, correspondence, entities } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import getCorrespondence from "./get";
import listCorrespondence from "./list";

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb.execute(
    sql`ALTER TABLE correspondence FORCE ROW LEVEL SECURITY`,
  );
});
afterAll(releaseRlsFixture);

const envelope = {
  messageId: "1234567890",
  messageType: "V",
  sender: {
    boxId: "abc2def",
    name: "Okresní soud v Testově",
    address: null,
    referenceNumber: "12 C 345/2026-17",
    fileMark: "12 C 345/2026",
  },
  recipient: {
    boxId: "xyz9876",
    name: "Advokátní kancelář Příklad",
    address: null,
    referenceNumber: null,
    fileMark: null,
  },
  toHands: null,
  personalDelivery: true,
  substituteDelivery: false,
  deliveredAt: "2026-10-14T07:12:33.120Z",
  acceptedAt: null,
  status: "delivered",
  seal: {
    status: "unverified",
    signerName: null,
    issuerName: null,
    serialNumber: null,
    signedAt: null,
  },
} as const satisfies DataBoxStatedEnvelope;

const dataBoxes = (id: string) => ({
  version: 1 as const,
  dataBoxes: [{ id, isPrimary: true }],
});

type RollbackWork = (
  tx: Parameters<Parameters<TestDatabase["transaction"]>[0]>[0],
) => Promise<void>;

const runInRollback = async (work: RollbackWork) => {
  try {
    await testDb.transaction(async (tx) => {
      await work(tx);
      tx.rollback();
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) {
      return;
    }
    throw error;
  }
  throw new Error("Expected integration transaction rollback");
};

const INVALID_DATA_BOX_ROWS = [
  {
    row: {
      channel: "data_box",
      dataBox: null,
      messageId: envelope.messageId,
      direction: null,
    },
    constraint: "correspondence_data_box_check",
  },
  {
    row: {
      channel: "data_box",
      dataBox: envelope,
      messageId: null,
      direction: null,
    },
    constraint: "correspondence_data_box_check",
  },
  {
    row: {
      channel: "data_box",
      dataBox: envelope,
      messageId: "999",
      direction: null,
    },
    constraint: "correspondence_data_box_check",
  },
  {
    row: {
      channel: "data_box",
      dataBox: { ...envelope, directionBasis: "organization_sender" },
      messageId: envelope.messageId,
      direction: null,
    },
    constraint: "correspondence_data_box_check",
  },
  {
    row: {
      channel: "data_box",
      dataBox: envelope,
      messageId: envelope.messageId,
      direction: "in",
    },
    constraint: "correspondence_direction_check",
  },
  {
    row: {
      channel: "data_box",
      dataBox: envelope,
      messageId: envelope.messageId,
      direction: "out",
    },
    constraint: "correspondence_direction_check",
  },
  {
    row: {
      channel: "email",
      dataBox: null,
      messageId: envelope.messageId,
      direction: null,
    },
    constraint: "correspondence_direction_check",
  },
] as const;

const causeChainText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
};

const insertDataBoxRow = async (
  row: (typeof INVALID_DATA_BOX_ROWS)[number]["row"],
) =>
  await runInRollback(async (tx) => {
    const sourceEntityId = createSafeId<"entity">();
    await tx.insert(entities).values({
      id: sourceEntityId,
      workspaceId: ids.wsA2,
      name: "zprava.zfo",
      createdBy: ids.userA1,
    });
    await tx.insert(correspondence).values({
      organizationId: ids.orgA,
      workspaceId: ids.wsA2,
      source: "upload",
      sourceEntityId,
      originalSignature: { status: "unverified" },
      contentHash: "a".repeat(64),
      dedupKey: "c".repeat(64),
      from: { address: "abc2def", name: null },
      to: [],
      cc: [],
      subject: "",
      receivedAt: new Date(),
      references: [],
      bodyText: "",
      ...row,
    });
  });

describe("data-box correspondence reads", () => {
  test("return the envelope and match box IDs to the organization's contacts only", async () => {
    await runInRollback(async (tx) => {
      const sourceEntityId = createSafeId<"entity">();
      const correspondenceId = createSafeId<"correspondence">();
      const senderContactId = createSafeId<"contact">();
      const otherOrganizationContactId = createSafeId<"contact">();
      await tx.insert(entities).values({
        id: sourceEntityId,
        workspaceId: ids.wsA2,
        name: "zprava.zfo",
        createdBy: ids.userA1,
      });
      await tx.insert(contacts).values([
        {
          id: senderContactId,
          organizationId: ids.orgA,
          type: "organization",
          displayName: "Okresní soud v Testově",
          organizationName: "Okresní soud v Testově",
          metadata: dataBoxes("abc2def"),
        },
        {
          id: createSafeId<"contact">(),
          organizationId: ids.orgA,
          type: "organization",
          displayName: "Unrelated authority",
          organizationName: "Unrelated authority",
          metadata: dataBoxes("qqq1111"),
        },
        {
          id: otherOrganizationContactId,
          organizationId: ids.orgB,
          type: "organization",
          displayName: "Another firm's court contact",
          organizationName: "Another firm's court contact",
          metadata: dataBoxes("abc2def"),
        },
      ]);
      await tx.insert(correspondence).values({
        id: correspondenceId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA2,
        channel: "data_box",
        dataBox: envelope,
        direction: null,
        source: "upload",
        sourceEntityId,
        originalSignature: { status: "unverified" },
        messageId: envelope.messageId,
        contentHash: "a".repeat(64),
        dedupKey: "b".repeat(64),
        from: { address: "abc2def", name: envelope.sender.name },
        to: [{ address: "xyz9876", name: envelope.recipient.name }],
        cc: [],
        subject: "Usnesení o nařízení jednání",
        receivedAt: new Date(envelope.deliveredAt),
        references: [],
        bodyText: "",
      });
      const context = {
        workspaceId: ids.wsA2,
        memberRole: sessionMemberRole("member"),
        user: { id: ids.userA1 },
        request: new Request("https://api.example.test/correspondence"),
        session: { activeOrganizationId: ids.orgA },
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(markRlsDatabase(tx), [ids.wsA2], ids.orgA, ids.userA1),
        ),
        recordAuditEvent: createAuditRecorder({
          organizationId: ids.orgA,
          workspaceId: ids.wsA2,
          userId: ids.userA1,
          request: new Request("https://api.example.test/correspondence"),
          server: null,
        }),
      };

      const detail = await getCorrespondence.handler(
        asTestRaw<Parameters<typeof getCorrespondence.handler>[0]>({
          ...context,
          params: { correspondenceId },
        }),
      );
      expect(detail).toMatchObject({
        record: {
          id: correspondenceId,
          channel: "data_box",
          dataBox: { ...envelope, directionBasis: "unknown" },
          direction: "in",
          source: "upload",
          sourceEntityId,
        },
        dataBoxContacts: {
          sender: {
            matches: [
              {
                contactId: senderContactId,
                displayName: "Okresní soud v Testově",
              },
            ],
            hasMore: false,
          },
          recipient: { matches: [], hasMore: false },
        },
      });

      await tx.insert(contacts).values(
        Array.from({ length: 5 }, (_, index) => ({
          id: createSafeId<"contact">(),
          organizationId: ids.orgA,
          type: "organization" as const,
          displayName: `Additional court contact ${index + 1}`,
          organizationName: `Additional court contact ${index + 1}`,
          metadata: dataBoxes("abc2def"),
        })),
      );
      const preview = await getCorrespondence.handler(
        asTestRaw<Parameters<typeof getCorrespondence.handler>[0]>({
          ...context,
          params: { correspondenceId },
        }),
      );
      if ("code" in preview) {
        throw new Error(
          `Expected correspondence detail, received ${preview.code}`,
        );
      }
      expect(preview.dataBoxContacts?.sender.matches).toHaveLength(5);
      expect(preview.dataBoxContacts?.sender.hasMore).toBe(true);
      expect(preview.dataBoxContacts?.recipient).toEqual({
        matches: [],
        hasMore: false,
      });

      const list = await listCorrespondence.handler(
        asTestRaw<Parameters<typeof listCorrespondence.handler>[0]>({
          ...context,
          query: { channel: "data_box" },
        }),
      );
      expect(list).toMatchObject({
        items: [
          {
            id: correspondenceId,
            channel: "data_box",
            dataBox: { ...envelope, directionBasis: "unknown" },
          },
        ],
      });
      expect(
        await listCorrespondence.handler(
          asTestRaw<Parameters<typeof listCorrespondence.handler>[0]>({
            ...context,
            query: { channel: "email" },
          }),
        ),
      ).toMatchObject({ items: [] });
    });
  });

  test("refuse invalid stored channel, direction, envelope, and message identity", async () => {
    for (const { row, constraint } of INVALID_DATA_BOX_ROWS) {
      expect(
        causeChainText(await rejectionOf(insertDataBoxRow(row))),
      ).toContain(constraint);
    }
  });
});
