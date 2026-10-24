import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, sql, TransactionRollbackError } from "drizzle-orm";

import type { DataBoxStatedEnvelope } from "@stll/api-contract/data-box";
import { roles } from "@stll/permissions";

import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  correspondence,
  entities,
  organizationSettings,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import getCorrespondence from "@/api/handlers/workspaces/correspondence/get";
import listCorrespondence from "@/api/handlers/workspaces/correspondence/list";
import updateCorrespondence from "@/api/handlers/workspaces/correspondence/update";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
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
  seal: {
    status: "unverified",
    signerName: null,
    issuerName: null,
    serialNumber: null,
    signedAt: null,
  },
} as const satisfies DataBoxStatedEnvelope;

type FileMessageOptions = {
  tx: Tx;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  createdBy: SafeId<"user">;
};

// Store only the file assertions; reads use the current organization boxes.
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
    direction: null,
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
  const [stored] = await tx
    .select({
      direction: correspondence.direction,
      envelope: correspondence.dataBox,
      organizationId: correspondence.organizationId,
      workspaceId: correspondence.workspaceId,
    })
    .from(correspondence)
    .where(eq(correspondence.id, id));
  if (stored === undefined) {
    return panic("Expected stored correspondence");
  }
  expect(stored.direction).toBeNull();
  expect(stored.envelope).not.toHaveProperty("directionBasis");
  const userId = stored.organizationId === ids.orgA ? ids.userA1 : ids.userB1;
  const context = {
    ...contextFor(tx),
    workspaceId: stored.workspaceId,
    session: { activeOrganizationId: stored.organizationId },
    user: { id: userId },
    safeDb: createSafeDb(
      markRlsDatabase(tx),
      [stored.workspaceId],
      stored.organizationId,
      userId,
    ),
    recordAuditEvent: createAuditRecorder({
      organizationId: stored.organizationId,
      workspaceId: stored.workspaceId,
      userId,
      request: new Request("https://api.example.test/correspondence"),
      server: null,
    }),
  };
  const detail = await getCorrespondence.handler(
    asTestRaw<Parameters<typeof getCorrespondence.handler>[0]>({
      ...context,
      params: { correspondenceId: id },
    }),
  );
  if (!("record" in detail) || detail.record.channel !== "data_box") {
    return panic("Expected projected data-box detail");
  }
  const list = await listCorrespondence.handler(
    asTestRaw<Parameters<typeof listCorrespondence.handler>[0]>({
      ...context,
      query: { channel: "data_box" },
    }),
  );
  if (!("items" in list)) {
    return panic("Expected projected correspondence page");
  }
  const listed = list.items.find((item) => item.id === id);
  expect(listed?.dataBox).toEqual(detail.record.dataBox);
  expect(listed).not.toHaveProperty("direction");
  const updated = await updateCorrespondence.handler(
    asTestRaw<Parameters<typeof updateCorrespondence.handler>[0]>({
      ...context,
      params: { correspondenceId: id },
      body: { handlingState: "handled" },
    }),
  );
  if (!("record" in updated)) {
    return panic("Expected projected correspondence update");
  }
  expect(updated.record.direction).toBe(detail.record.direction);
  expect(updated.record.dataBox).toEqual(detail.record.dataBox);
  return {
    direction: detail.record.direction,
    basis: detail.record.dataBox.directionBasis,
  };
};

describe("organization data boxes", () => {
  test("all wire producers derive direction while filing preserves the raw envelope", async () => {
    await runInRollback(async (tx) => {
      const sourceEntityId = createSafeId<"entity">();
      await tx.insert(entities).values({
        id: sourceEntityId,
        workspaceId: ids.wsA1,
        name: "message.zfo",
        createdBy: ids.userA1,
      });
      const context = contextFor(tx);
      await addOrganizationDataBox.handler(
        asTestRaw<Parameters<typeof addOrganizationDataBox.handler>[0]>({
          ...context,
          body: { boxId: FIRM_BOX },
        }),
      );
      const filed = await createCorrespondence({
        safeDb: context.safeDb,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        filer: { type: "user", userId: ids.userA1 },
        parsed: {
          source: "upload",
          sourceEntityId,
          originalSignature: { status: "unverified" },
          channel: "data_box",
          dataBox: envelope,
          direction: null,
          messageId: envelope.messageId,
          contentHash: "b".repeat(64),
          from: { address: FIRM_BOX, name: null },
          to: [{ address: COURT_BOX, name: null }],
          cc: [],
          subject: "Odpor",
          sentAt: null,
          receivedAt: envelope.deliveredAt,
          inReplyTo: null,
          references: [],
          bodyText: "",
          bodyHtml: null,
        },
        attachments: [],
        recordAuditEvent: context.recordAuditEvent,
      });
      expect(filed.type).toBe("ok");
      if (filed.type !== "ok") {
        throw new TypeError("Expected filed data-box message");
      }
      expect(await directionOf(tx, filed.id)).toEqual({
        direction: "out",
        basis: "organization_sender",
      });
    });
  });

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
      expect(added).toEqual({ boxIds: [FIRM_BOX] });
      expect(await directionOf(tx, own)).toEqual({
        direction: "out",
        basis: "organization_sender",
      });
      expect(await directionOf(tx, otherOrganization)).toEqual({
        direction: "in",
        basis: "unknown",
      });
      expect(
        await getCorrespondence.handler(
          asTestRaw<Parameters<typeof getCorrespondence.handler>[0]>({
            ...contextFor(tx),
            workspaceId: ids.wsB1,
            params: { correspondenceId: otherOrganization },
          }),
        ),
      ).toMatchObject({ code: 404 });

      const repeated = await addOrganizationDataBox.handler(
        asTestRaw<Parameters<typeof addOrganizationDataBox.handler>[0]>({
          ...contextFor(tx),
          body: { boxId: FIRM_BOX },
        }),
      );
      expect(repeated).toEqual({ boxIds: [FIRM_BOX] });

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
      expect(removed).toEqual({ boxIds: [] });
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

  test("settings changes never rewrite filed envelope or record timestamps", async () => {
    await runInRollback(async (tx) => {
      const id = await fileMessage({
        tx,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        createdBy: ids.userA1,
      });
      const before = await tx
        .select()
        .from(correspondence)
        .where(eq(correspondence.id, id))
        .limit(1);
      await addOrganizationDataBox.handler(
        asTestRaw<Parameters<typeof addOrganizationDataBox.handler>[0]>({
          ...contextFor(tx),
          body: { boxId: FIRM_BOX },
        }),
      );
      await removeOrganizationDataBox.handler(
        asTestRaw<Parameters<typeof removeOrganizationDataBox.handler>[0]>({
          ...contextFor(tx),
          params: { boxId: FIRM_BOX },
        }),
      );
      expect(
        await tx
          .select()
          .from(correspondence)
          .where(eq(correspondence.id, id))
          .limit(1),
      ).toEqual(before);
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
      expect(added).toEqual({ boxIds: [COURT_BOX] });
      expect(await directionOf(tx, message)).toEqual({
        direction: "in",
        basis: "organization_recipient",
      });
    });
  });
});
