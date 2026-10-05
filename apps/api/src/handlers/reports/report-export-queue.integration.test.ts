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
import JSZip from "jszip";

import { filtersFromFieldConfig } from "@stll/template-conditions";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { reportExports, templates, workspaceMembers } from "@/api/db/schema";
import type { ViewLayout } from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import * as reportData from "@/api/handlers/reports/build-report-data";
import {
  DD_REPORT_KEY,
  initBuiltinReportTemplates,
} from "@/api/handlers/reports/builtin-templates";
import { processReportExport } from "@/api/handlers/reports/report-export-queue";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import * as chatRuntime from "@/api/lib/chat/tanstack-chat-runtime";
import type { FieldMeta } from "@/api/lib/docx/types";
import { writeFieldFilters } from "@/api/lib/docx/write-field-filters";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedReportExportId } from "@/api/lib/safe-id-boundaries";
import * as modelTransport from "@/api/lib/tanstack-ai-generate";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { testDocxFile } from "@/api/tests/helpers/scanned-file";
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
  await processReportExport(actor, {
    admission: testModelAdmission(actor.organizationId),
    format: "docx",
    aiNarrative: true,
  });
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
    await processReportExport(actor, {
      admission: testModelAdmission(actor.organizationId),
      format: "docx",
      aiNarrative: false,
    });
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

  /** A stored report template in org A whose body is `paragraphs`, with
   *  `conditions` authored as AI-decided conditions. */
  const insertStoredTemplate = async ({
    paragraphs,
    conditions,
  }: {
    paragraphs: readonly string[];
    conditions: readonly FieldMeta[];
  }) => {
    const templateId = createSafeId<"template">();
    const s3Key = `report-templates/${templateId}.docx`;
    const body = paragraphs
      .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
      .join("");
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    );
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    );
    const { file } = await writeFieldFilters(
      testDocxFile(await zip.generateAsync({ type: "uint8array" })),
      [],
      conditions.map((condition) => ({
        path: condition.path,
        expression: undefined,
        filters: filtersFromFieldConfig(condition),
      })),
    );
    fakeS3.put("stella", s3Key, new Uint8Array(file.bytes));
    await testDb.insert(templates).values({
      id: templateId,
      organizationId: ids.orgA,
      name: "Consumer report",
      fileName: "consumer-report.docx",
      s3Key,
      sizeBytes: file.bytes.byteLength,
      scanState: "scanned",
      createdBy: ids.userA1,
    });
    return templateId;
  };

  const readTemplateUse = async (templateId: SafeId<"template">) =>
    (
      await testDb
        .select({
          useCount: templates.useCount,
          lastUsedAt: templates.lastUsedAt,
        })
        .from(templates)
        .where(eq(templates.id, templateId))
        .limit(1)
    ).at(0);

  /** Run a deterministic export of the stored template. */
  const exportStoredTemplate = async (templateId: SafeId<"template">) => {
    await testDb
      .update(reportExports)
      .set({
        aiNarrative: false,
        templateRef: { type: "stored", templateId },
      })
      .where(eq(reportExports.id, exportId));
    await processReportExport(actor, {
      admission: testModelAdmission(actor.organizationId),
      format: "docx",
      aiNarrative: false,
    });
  };

  test("a stored template whose AI condition stays undecided fails the export with the condition named and no use recorded", async () => {
    const templateId = await insertStoredTemplate({
      paragraphs: [
        "Report.",
        "{% if is_consumer %}",
        "Consumer notice.",
        "{% endif %}",
      ],
      conditions: [
        {
          path: "is_consumer",
          label: "Consumer contract",
          inputType: "boolean",
          aiPrompt: "Is this a consumer contract?",
        },
      ],
    });
    try {
      // A deterministic export runs no AI tier, so the condition is
      // undecided (no backend) and its block would render as if false.
      await exportStoredTemplate(templateId);

      expect(await readExport()).toMatchObject({
        status: "failed",
        error:
          "Report template fill incomplete; AI-decided conditions left undecided: is_consumer (no-backend)",
        resultS3Key: null,
      });
      expect(
        objectWrites().filter((request) => request.key.startsWith("exports/")),
      ).toEqual([]);
      // The export produced nothing, so the template was not used.
      expect(await readTemplateUse(templateId)).toEqual({
        useCount: 0,
        lastUsedAt: null,
      });
    } finally {
      await testDb.delete(templates).where(eq(templates.id, templateId));
    }
  });

  test("a stored template export that completes records one use", async () => {
    const templateId = await insertStoredTemplate({
      paragraphs: ["Report."],
      conditions: [],
    });
    try {
      await exportStoredTemplate(templateId);

      expect(await readExport()).toMatchObject({
        status: "completed",
        error: null,
      });
      const used = await readTemplateUse(templateId);
      expect(used?.useCount).toBe(1);
      expect(used?.lastUsedAt).toBeInstanceOf(Date);
    } finally {
      await testDb.delete(templates).where(eq(templates.id, templateId));
    }
  });
});
