import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { auditLogs, chatThreads, workspaces } from "@/api/db/schema";
import { createMembershipSafeDb, createSafeDb } from "@/api/db/scoped";
import renameThread from "@/api/handlers/chat/threads/rename";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { ChatAuditResourceType } from "@/api/lib/audit-log-details";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { expandThreadDataScopeOnTx } from "@/api/lib/chat/data-scope";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import exportAuditLogs from "./export";
import { queryAuditLogPage } from "./query";

setDefaultTimeout(120_000);

type RenameContext = Parameters<typeof renameThread.handler>[0];
type ExportContext = Parameters<typeof exportAuditLogs.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;
let matterId: SafeId<"workspace">;
const seededThreadIds: SafeId<"chatThread">[] = [];
const seededResourceIds: string[] = [];

const unwrittenAuditRecorder: AuditRecorder = auditRecorderDouble();

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  // A matter of organization A without a client: organization readers do not
  // reach it through their role alone.
  matterId = toSafeId<"workspace">(Bun.randomUUIDv7());
  await testDb.insert(workspaces).values({
    id: matterId,
    organizationId: ids.orgA,
    name: "Matter T",
    reference: matterId,
    status: "active",
  });
});

afterAll(async () => {
  const auditedIds = [...seededThreadIds, ...seededResourceIds];
  if (auditedIds.length > 0) {
    await testDb
      .delete(auditLogs)
      .where(inArray(auditLogs.resourceId, auditedIds));
  }
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await testDb.delete(workspaces).where(eq(workspaces.id, matterId));
  await releaseRlsFixture();
});

const ownerDb = () =>
  asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1, matterId], ids.orgA, ids.userA1),
  );

const organizationReaderDb = () =>
  asTestRaw<SafeDb>(
    createMembershipSafeDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [],
      userId: ids.userAdmin,
    }),
  );

const matterReaderDb = () =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [matterId], ids.orgA, ids.userA1));

/** An organization-level thread whose content draws on `dataWorkspaceIds`. */
const seedOrganizationThread = async (
  dataWorkspaceIds: SafeId<"workspace">[],
): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    title: "New chat",
    workspaceId: null,
    contextMatterIds: [],
    dataWorkspaceIds,
  });
  seededThreadIds.push(threadId);
  return threadId;
};

const rename = async (threadId: SafeId<"chatThread">, title: string) => {
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: null,
    userId: ids.userA1,
    execution: {
      performer: { type: "user", id: ids.userA1 },
      trigger: { type: "direct" },
    },
  });
  const result = await renameThread.handler(
    asTestRaw<RenameContext>({
      body: { title },
      getWorkspaceAccess: async () => {
        throw new TypeError("organization threads need no matter lookup");
      },
      memberRole: sessionMemberRole("owner"),
      params: { threadId },
      query: {},
      recordAuditEvent,
      request: new Request(`http://localhost/v1/chat/threads/${threadId}`),
      route: "/v1/chat/threads/:threadId/title",
      safeDb: ownerDb(),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );
  expect(result).toEqual({ title });
};

const readEntries = async (
  reader: SafeDb,
  resourceId: string,
  resourceType: ChatAuditResourceType = AUDIT_RESOURCE_TYPE.CHAT_THREAD,
) => {
  const result = await Result.gen(() =>
    queryAuditLogPage({
      safeDb: reader,
      organizationId: ids.orgA,
      userId: ids.userA1,
      featureAccessSnapshot: undefined,
      recordAuditEvent: unwrittenAuditRecorder,
      query: {
        limit: 50,
        resourceType,
        resourceId,
      },
    }),
  );
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value.items;
};

const exportEntries = async (
  reader: SafeDb,
  resourceId: string,
  resourceType: ChatAuditResourceType = AUDIT_RESOURCE_TYPE.CHAT_THREAD,
) => {
  const result = await exportAuditLogs.handler(
    asTestRaw<ExportContext>({
      memberRole: sessionMemberRole("owner"),
      query: { resourceType, resourceId },
      recordAuditEvent: unwrittenAuditRecorder,
      request: new Request("http://localhost/v1/audit-logs/export"),
      route: "/v1/audit-logs/export",
      safeDb: reader,
      session: { activeOrganizationId: ids.orgA },
      set: { headers: {} },
      user: { id: ids.userAdmin },
    }),
  );
  if (typeof result !== "string") {
    throw new TypeError(`export failed: ${JSON.stringify(result)}`);
  }
  return result;
};

const titleUpdate = {
  titleChanged: { old: false, new: true },
  titleSource: { old: "default", new: "user" },
};

describe("audit entries for chat titles follow thread visibility", () => {
  test("an organization reader sees the title event of a matter-backed thread without its text", async () => {
    const threadId = await seedOrganizationThread([matterId]);
    const marker = `Title ${Bun.randomUUIDv7()}`;
    await rename(threadId, marker);

    const entries = await readEntries(organizationReaderDb(), threadId);
    expect(entries.map((entry) => entry.changes)).toEqual([titleUpdate]);
    expect(JSON.stringify(entries)).not.toContain(marker);

    const csv = await exportEntries(organizationReaderDb(), threadId);
    expect(csv).toContain(threadId);
    expect(csv).not.toContain(marker);

    const [stored] = await testDb
      .select({ changes: auditLogs.changes })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, threadId));
    expect(JSON.stringify(stored)).not.toContain(marker);
  });

  test("a reader of the source matter still sees the title event", async () => {
    const threadId = await seedOrganizationThread([matterId]);
    await rename(threadId, `Title ${Bun.randomUUIDv7()}`);

    const entries = await readEntries(matterReaderDb(), threadId);
    expect(entries.map((entry) => entry.changes)).toEqual([titleUpdate]);
  });

  test("a thread without matter data records the same title event", async () => {
    const threadId = await seedOrganizationThread([]);
    await rename(threadId, `Title ${Bun.randomUUIDv7()}`);

    const entries = await readEntries(organizationReaderDb(), threadId);
    expect(entries.map((entry) => entry.action)).toEqual([AUDIT_ACTION.UPDATE]);
    expect(entries.map((entry) => entry.changes)).toEqual([titleUpdate]);
  });

  test("stored chat entries show only their listed change fields", async () => {
    const threadId = await seedOrganizationThread([matterId]);
    const marker = `Title ${Bun.randomUUIDv7()}`;
    const recorder = createBackgroundAuditRecorder({
      organizationId: ids.orgA,
      workspaceId: null,
      userId: ids.userA1,
      execution: {
        performer: { type: "user", id: ids.userA1 },
        trigger: { type: "direct" },
      },
    });
    await recorder(asTestRaw<Transaction>(testDb), {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
      resourceId: threadId,
      changes: { chatModel: { old: "model-a", new: "model-b" } },
    });
    // An entry written before the projection existed keeps its raw payload.
    await testDb
      .update(auditLogs)
      .set({
        changes: {
          chatModel: { old: "model-a", new: "model-b" },
          name: { old: null, new: marker },
          created: { old: null, new: { summary: marker, chatModel: "m" } },
        },
      })
      .where(eq(auditLogs.resourceId, threadId));

    const entries = await readEntries(organizationReaderDb(), threadId);
    expect(entries.map((entry) => entry.changes)).toEqual([
      {
        chatModel: { old: "model-a", new: "model-b" },
        created: { old: null, new: { chatModel: "m" } },
      },
    ]);
    const csv = await exportEntries(organizationReaderDb(), threadId);
    expect(csv).not.toContain(marker);
  });
});

const ownerRecorder = () =>
  createBackgroundAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: null,
    userId: ids.userA1,
    execution: {
      performer: { type: "user", id: ids.userA1 },
      trigger: { type: "direct" },
    },
  });

/** Records one event the way its writer does, then reads it back both ways. */
const recordAndRead = async (event: AuditEvent, reader: SafeDb) => {
  seededResourceIds.push(event.resourceId);
  await ownerRecorder()(asTestRaw<Transaction>(testDb), event);
  const resourceType = asTestRaw<ChatAuditResourceType>(event.resourceType);
  const entries = await readEntries(reader, event.resourceId, resourceType);
  const csv = await exportEntries(reader, event.resourceId, resourceType);
  return { entries, csv };
};

describe("chat setting entries keep their listed fields", () => {
  test("a data scope change keeps its matter ids", async () => {
    const threadId = await seedOrganizationThread([]);
    await expandThreadDataScopeOnTx({
      newWorkspaceIds: [matterId],
      recordAuditEvent: ownerRecorder(),
      threadId,
      threadWorkspaceId: null,
      tx: asTestRaw<Transaction>(testDb),
    });

    const entries = await readEntries(organizationReaderDb(), threadId);
    expect(entries.map((entry) => entry.changes)).toEqual([
      { dataWorkspaceIds: { old: [], new: [matterId] } },
    ]);
    const csv = await exportEntries(organizationReaderDb(), threadId);
    expect(csv).toContain("dataWorkspaceIds");
    expect(csv).toContain(matterId);
  });

  test("a thread moved into a matter keeps its matter change", async () => {
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    const { entries, csv } = await recordAndRead(
      {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
        resourceId: threadId,
        workspaceId: matterId,
        changes: { workspaceId: { old: null, new: matterId } },
      },
      matterReaderDb(),
    );
    expect(entries.map((entry) => entry.changes)).toEqual([
      { workspaceId: { old: null, new: matterId } },
    ]);
    expect(csv).toContain("workspaceId");
  });

  test("a message destination change keeps its destination", async () => {
    const messageId = Bun.randomUUIDv7();
    const { entries, csv } = await recordAndRead(
      {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
        resourceId: messageId,
        workspaceId: matterId,
        changes: {
          createDocumentDestination: { old: "draft", new: "matter" },
        },
      },
      matterReaderDb(),
    );
    expect(entries.map((entry) => entry.changes)).toEqual([
      { createDocumentDestination: { old: "draft", new: "matter" } },
    ]);
    expect(csv).toContain("createDocumentDestination");
  });

  test("model, reasoning, web search and pinned matter changes keep their values", async () => {
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    const changes = {
      chatModel: { old: "model-a", new: "model-b" },
      chatReasoningEffort: { old: "low", new: "high" },
      contextMatterIds: { old: [], new: [matterId] },
      webSearchEnabled: { old: false, new: true },
      created: { old: null, new: { chatModel: "model-a" } },
    };
    const { entries } = await recordAndRead(
      {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
        resourceId: threadId,
        workspaceId: null,
        changes,
      },
      organizationReaderDb(),
    );
    expect(entries.map((entry) => entry.changes)).toEqual([changes]);
  });
});
