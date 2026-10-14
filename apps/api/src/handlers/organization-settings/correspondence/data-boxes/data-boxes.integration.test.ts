import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, sql, TransactionRollbackError } from "drizzle-orm";

import type { DataBoxEnvelope } from "@stll/api-contract/data-box";
import { roles } from "@stll/permissions";

import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  correspondence,
  entities,
  organizationSettings,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import addOrganizationDataBox from "./create";
import removeOrganizationDataBox from "./delete";
import getOrganizationDataBoxes from "./get";

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

type Tx = Parameters<Parameters<TestDatabase["transaction"]>[0]>[0];

const FIRM_BOX = "abc2def";
const COURT_BOX = "xyz9876";

const envelope = {
  messageId: "1234567890",
  messageType: "V",
  sender: {
    boxId: FIRM_BOX,
    name: "Advokátní kancelář Příklad",
    address: null,
    referenceNumber: null,
    fileMark: null,
  },
  recipient: {
    boxId: COURT_BOX,
    name: "Okresní soud v Testově",
    address: null,
    referenceNumber: null,
    fileMark: null,
  },
  toHands: null,
  personalDelivery: null,
  substituteDelivery: null,
  deliveredAt: "2026-10-14T07:12:33.120Z",
  acceptedAt: null,
  status: "delivered",
  directionBasis: "unknown",
  seal: {
    status: "unverified",
    signerName: null,
    issuerName: null,
    serialNumber: null,
    signedAt: null,
  },
} as const satisfies DataBoxEnvelope;

type FileMessageOptions = {
  tx: Tx;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  createdBy: SafeId<"user">;
};

// A message filed before the organization listed its boxes: incoming, with
// an unknown basis.
const fileMessage = async ({
  tx,
  organizationId,
  workspaceId,
  createdBy,
}: FileMessageOptions) => {
  const id = createSafeId<"correspondence">();
  const sourceEntityId = createSafeId<"entity">();
  await tx.insert(entities).values({
    id: sourceEntityId,
    workspaceId,
    name: "zprava.zfo",
    createdBy,
  });
  await tx.insert(correspondence).values({
    id,
    organizationId,
    workspaceId,
    channel: "data_box",
    dataBox: envelope,
    direction: "in",
    source: "upload",
    sourceEntityId,
    originalSignature: { status: "unverified" },
    messageId: envelope.messageId,
    contentHash: "a".repeat(64),
    dedupKey: id.replaceAll("-", "").repeat(2),
    from: { address: FIRM_BOX, name: null },
    to: [{ address: COURT_BOX, name: null }],
    cc: [],
    subject: "Odpor",
    receivedAt: new Date(envelope.deliveredAt),
    references: [],
    bodyText: "",
  });
  return id;
};

const contextFor = (tx: Tx) => ({
  memberRole: sessionMemberRole("owner"),
  user: { id: ids.userA1 },
  request: new Request("https://api.example.test/organization-settings"),
  session: { activeOrganizationId: ids.orgA },
  safeDb: asTestRaw<SafeDb>(
    createSafeDb(
      markRlsDatabase(tx),
      [ids.wsA1, ids.wsA2],
      ids.orgA,
      ids.userA1,
    ),
  ),
  recordAuditEvent: createAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: null,
    userId: ids.userA1,
    request: new Request("https://api.example.test/organization-settings"),
    server: null,
  }),
});

const runInRollback = async (work: (tx: Tx) => Promise<void>) => {
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

const directionOf = async (tx: Tx, id: SafeId<"correspondence">) => {
  await tx.execute(sql`RESET ROLE`);
  const [row] = await tx
    .select({
      direction: correspondence.direction,
      basis: sql<string>`${correspondence.dataBox} ->> 'directionBasis'`,
    })
    .from(correspondence)
    .where(eq(correspondence.id, id));
  return row;
};

describe("organization data boxes", () => {
  test("only organization administrators may change them", () => {
    expect(addOrganizationDataBox.config.permissions).toEqual({
      organizationSettings: ["update"],
    });
    expect(removeOrganizationDataBox.config.permissions).toEqual({
      organizationSettings: ["update"],
    });
    expect(
      roles.member.authorize({ organizationSettings: ["update"] }).success,
    ).toBe(false);
  });

  test("adding and removing a box re-derives directions in the organization only", async () => {
    await runInRollback(async (tx) => {
      const own = await fileMessage({
        tx,
        organizationId: ids.orgA,
        workspaceId: ids.wsA2,
        createdBy: ids.userA1,
      });
      const otherOrganization = await fileMessage({
        tx,
        organizationId: ids.orgB,
        workspaceId: ids.wsB1,
        createdBy: ids.userB1,
      });

      const added = await addOrganizationDataBox.handler(
        asTestRaw<Parameters<typeof addOrganizationDataBox.handler>[0]>({
          ...contextFor(tx),
          body: { boxId: FIRM_BOX.toUpperCase() },
        }),
      );
      expect(added).toEqual({ boxIds: [FIRM_BOX], recomputed: 1 });
      expect(await directionOf(tx, own)).toEqual({
        direction: "out",
        basis: "organization_sender",
      });
      expect(await directionOf(tx, otherOrganization)).toEqual({
        direction: "in",
        basis: "unknown",
      });

      const repeated = await addOrganizationDataBox.handler(
        asTestRaw<Parameters<typeof addOrganizationDataBox.handler>[0]>({
          ...contextFor(tx),
          body: { boxId: FIRM_BOX },
        }),
      );
      expect(repeated).toEqual({ boxIds: [FIRM_BOX], recomputed: 0 });

      const read = await getOrganizationDataBoxes.handler(
        asTestRaw<Parameters<typeof getOrganizationDataBoxes.handler>[0]>(
          contextFor(tx),
        ),
      );
      expect(read).toEqual({ boxIds: [FIRM_BOX] });

      const removed = await removeOrganizationDataBox.handler(
        asTestRaw<Parameters<typeof removeOrganizationDataBox.handler>[0]>({
          ...contextFor(tx),
          params: { boxId: FIRM_BOX },
        }),
      );
      expect(removed).toEqual({ boxIds: [], recomputed: 1 });
      expect(await directionOf(tx, own)).toEqual({
        direction: "in",
        basis: "unknown",
      });

      await tx.execute(sql`RESET ROLE`);
      expect(
        await tx
          .select({ dataBoxIds: organizationSettings.dataBoxIds })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, ids.orgB)),
      ).not.toContainEqual({ dataBoxIds: [FIRM_BOX] });
      expect(
        await tx
          .select({ changes: auditLogs.changes })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.resourceId, ids.orgA),
              sql`jsonb_exists(${auditLogs.changes}, 'dataBoxIds')`,
            ),
          )
          .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id)),
      ).toEqual([
        { changes: { dataBoxIds: { old: [], new: [FIRM_BOX] } } },
        { changes: { dataBoxIds: { old: [FIRM_BOX], new: [] } } },
      ]);
    });
  });

  test("the recipient box marks a message incoming", async () => {
    await runInRollback(async (tx) => {
      const message = await fileMessage({
        tx,
        organizationId: ids.orgA,
        workspaceId: ids.wsA2,
        createdBy: ids.userA1,
      });
      const added = await addOrganizationDataBox.handler(
        asTestRaw<Parameters<typeof addOrganizationDataBox.handler>[0]>({
          ...contextFor(tx),
          body: { boxId: COURT_BOX },
        }),
      );
      expect(added).toEqual({ boxIds: [COURT_BOX], recomputed: 1 });
      expect(await directionOf(tx, message)).toEqual({
        direction: "in",
        basis: "organization_recipient",
      });
    });
  });
});
