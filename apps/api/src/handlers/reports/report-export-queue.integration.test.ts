/**
 * A report export reads the view it reports on under its requester's current
 * access, so the run builds nothing from a matter the requester can no longer
 * open. Driven against a real (PGlite) database and an in-process object store.
 */

import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { reportExports, workspaceMembers } from "@/api/db/schema";
import type { ViewLayout } from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import * as reportData from "@/api/handlers/reports/build-report-data";
import {
  DD_REPORT_KEY,
  initBuiltinReportTemplates,
} from "@/api/handlers/reports/builtin-templates";
import { processReportExport } from "@/api/handlers/reports/report-export-queue";
import * as chatRuntime from "@/api/lib/chat/tanstack-chat-runtime";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedReportExportId } from "@/api/lib/safe-id-boundaries";
import * as modelTransport from "@/api/lib/tanstack-ai-generate";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

setDefaultTimeout(120_000);

await initBuiltinReportTemplates();
const { testDb, ids } = await getRlsFixture();
const database = asTestRaw<RlsDatabase<Transaction>>(testDb);
const fakeS3 = startFakeS3();

const originalOrganizationMember = (
  await testDb
    .select()
    .from(member)
    .where(eq(member.id, ids.memberA1org))
    .limit(1)
).at(0);
const originalMatterMember = await testDb.query.workspaceMembers.findFirst({
  where: { id: { eq: ids.memberA1wsA1 } },
});
if (!originalOrganizationMember || !originalMatterMember) {
  panic("Report export fixture is incomplete");
}

const tableLayout: Extract<ViewLayout, { type: "table" }> = {
  type: "table",
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
  columnOrder: [],
  columnPinning: [],
};

const exportId = brandPersistedReportExportId(Bun.randomUUIDv7());
const actor = {
  ...createRootRunActor(
    {
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      runId: exportId,
    },
    brandPersistedReportExportId,
    database,
  ),
  exportId,
};

const reportDataSpy = spyOn(reportData, "buildReportData");
const textModelSpy = spyOn(modelTransport, "generateTanStackTextForRole");
const objectModelSpy = spyOn(modelTransport, "generateTanStackObjectForRole");
const chatObjectSpy = spyOn(chatRuntime, "generateChatObject");

const readExport = async () =>
  (
    await testDb
      .select()
      .from(reportExports)
      .where(eq(reportExports.id, exportId))
      .limit(1)
  ).at(0);

const objectWrites = () =>
  fakeS3.requests.filter((request) => request.method === "PUT");

beforeEach(async () => {
  reportDataSpy.mockClear();
  textModelSpy.mockClear();
  objectModelSpy.mockClear();
  chatObjectSpy.mockClear();
  for (const spy of [textModelSpy, objectModelSpy, chatObjectSpy]) {
    spy.mockImplementation(async () => panic("Unexpected model call"));
  }
  fakeS3.requests.length = 0;
  await testDb.insert(reportExports).values({
    id: exportId,
    workspaceId: ids.wsA1,
    requestedBy: ids.userA1,
    templateRef: { type: "builtin", key: DD_REPORT_KEY },
    layout: tableLayout,
    status: "queued",
    mode: "download",
    format: "docx",
    aiNarrative: true,
  });
});

afterEach(async () => {
  await testDb.delete(reportExports).where(eq(reportExports.id, exportId));
  await testDb
    .insert(member)
    .values(originalOrganizationMember)
    .onConflictDoNothing();
  await testDb
    .insert(workspaceMembers)
    .values(originalMatterMember)
    .onConflictDoNothing();
});

afterAll(async () => {
  reportDataSpy.mockRestore();
  textModelSpy.mockRestore();
  objectModelSpy.mockRestore();
  chatObjectSpy.mockRestore();
  fakeS3.stop();
  await releaseRlsFixture();
});

const expectStoppedBeforeReading = async () => {
  await processReportExport(actor, { format: "docx", aiNarrative: true });
  expect(await readExport()).toMatchObject({
    status: "failed",
    error: "The report source is no longer available.",
    resultS3Key: null,
  });
  expect(reportDataSpy).not.toHaveBeenCalled();
  expect(textModelSpy).not.toHaveBeenCalled();
  expect(objectModelSpy).not.toHaveBeenCalled();
  expect(chatObjectSpy).not.toHaveBeenCalled();
  expect(objectWrites()).toEqual([]);
};

describe("report export run", () => {
  test("a run stops when its requester no longer has access to the matter", async () => {
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA1));
    await expectStoppedBeforeReading();
  });

  test("a run stops when its requester has left the organization", async () => {
    await testDb.delete(member).where(eq(member.id, ids.memberA1org));
    await expectStoppedBeforeReading();
  });

  test("a run completes while its requester keeps access", async () => {
    await testDb
      .update(reportExports)
      .set({ aiNarrative: false })
      .where(eq(reportExports.id, exportId));
    await processReportExport(actor, { format: "docx", aiNarrative: false });
    const row = await readExport();
    expect(row).toMatchObject({ status: "completed", error: null });
    expect(reportDataSpy).toHaveBeenCalledTimes(1);
    expect(objectWrites().map((request) => request.key)).toEqual([
      row?.resultS3Key ?? panic("Export result key missing"),
    ]);
    expect(textModelSpy).not.toHaveBeenCalled();
    expect(objectModelSpy).not.toHaveBeenCalled();
    expect(chatObjectSpy).not.toHaveBeenCalled();
  });
});
