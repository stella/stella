/**
 * Filling a stored template into a matter records the fill's completion
 * decision: a document whose AI-decided condition nothing settled is saved,
 * but the fill is recorded `partial` and the response names the condition.
 *
 * Driven end to end against a real (PGlite) database and an in-process object
 * store: the renderer, condition resolution and document creation are real.
 * The deployment has no AI backend of any tier, so the condition is undecided
 * `no-backend` and no model is ever called.
 */

import { panic } from "better-result";
import {
  afterAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import JSZip from "jszip";

import { filtersFromFieldConfig } from "@stll/template-conditions";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, templateFills, templates } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import fillTemplateToWorkspace from "@/api/handlers/templates/fills/create";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { FieldMeta } from "@/api/lib/docx/types";
import { writeFieldFilters } from "@/api/lib/docx/write-field-filters";
import * as tanstackModels from "@/api/lib/tanstack-ai-models";
import * as decisionModel from "@/api/lib/workflow/decisions/decision-model";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { testDocxFile } from "@/api/tests/helpers/scanned-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

setDefaultTimeout(120_000);

const { testDb, ids } = await getRlsFixture();
const fakeS3 = startFakeS3();
const instanceProviderSpy = spyOn(
  tanstackModels,
  "hasTanStackInstanceProvider",
).mockReturnValue(false);
const instanceDecisionModelSpy = spyOn(
  decisionModel,
  "hasInstanceDecisionModel",
).mockReturnValue(false);

afterAll(async () => {
  instanceProviderSpy.mockRestore();
  instanceDecisionModelSpy.mockRestore();
  fakeS3.stop();
  await releaseRlsFixture();
});

const conditionField: FieldMeta = {
  path: "is_consumer",
  label: "Consumer contract",
  inputType: "boolean",
  aiPrompt: "Is this a consumer contract?",
};

const PARAGRAPHS = [
  "Preamble.",
  "{% if is_consumer %}",
  "Consumer notice.",
  "{% endif %}",
  "{% if not is_consumer %}",
  "Business terms.",
  "{% endif %}",
];

/** A block gated on the condition and one on its negation: an unset
 *  condition drops the first and keeps the second, neither of which anyone
 *  decided. */
const gatedDocx = async () => {
  const body = PARAGRAPHS.map(
    (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`,
  ).join("");
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  const { file, written } = await writeFieldFilters(
    testDocxFile(await zip.generateAsync({ type: "uint8array" })),
    [],
    [
      {
        path: conditionField.path,
        expression: undefined,
        filters: filtersFromFieldConfig(conditionField),
      },
    ],
  );
  if (!written.has(conditionField.path)) {
    panic("fixture has no {% if is_consumer %} tag to configure");
  }
  return file;
};

const recordNothing: AuditRecorder = async () => {
  await Promise.resolve();
};

describe("fill to workspace records the completion decision", () => {
  test("an undecided AI condition saves the document but records the fill as partial", async () => {
    const templateId = createSafeId<"template">();
    const s3Key = `templates/${templateId}.docx`;
    const docx = await gatedDocx();
    fakeS3.put("stella", s3Key, new Uint8Array(docx.bytes));
    await testDb.insert(templates).values({
      id: templateId,
      organizationId: ids.orgA,
      name: "NDA",
      fileName: "nda.docx",
      s3Key,
      sizeBytes: docx.bytes.byteLength,
      scanState: "scanned",
      createdBy: ids.userA1,
    });
    const scopedDb = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    );
    let createdEntityId: string | undefined;
    const templateEvents: Record<string, unknown>[] = [];
    const recordTemplateEvents: AuditRecorder = async (_tx, event) => {
      for (const each of Array.isArray(event) ? event : [event]) {
        if (each.resourceType === AUDIT_RESOURCE_TYPE.TEMPLATE) {
          templateEvents.push({ ...each });
        }
      }
      await Promise.resolve();
    };
    try {
      const result = await fillTemplateToWorkspace.handler(
        createTestHandlerContext<
          Parameters<typeof fillTemplateToWorkspace.handler>[0]
        >({
          workspaceId: ids.wsA1,
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
          safeDb: toSafeDbMock(scopedDb),
          scopedDb,
          audit: recordNothing,
          // The handler rebinds its recorder to the validated workspace.
          createAuditRecorder: () => recordTemplateEvents,
          orgAIConfig: null,
          params: { workspaceId: ids.wsA1, templateId },
          body: { values: {}, name: "Consumer NDA" },
        }),
      );

      expect(result).toMatchObject({
        completionStatus: "partial",
        unmatchedPlaceholders: [],
        aiFieldErrors: [],
        structureErrors: [],
        undecidedConditions: [
          {
            path: "is_consumer",
            label: "Consumer contract",
            reason: "no-backend",
          },
        ],
      });
      createdEntityId = asTestRaw<{ entityId: string }>(result).entityId;

      const fills = await testDb
        .select()
        .from(templateFills)
        .where(eq(templateFills.templateId, templateId));
      expect(fills.map(({ status }) => status)).toEqual(["partial"]);
      // Audited with the same counts the chat and MCP fills record.
      expect(templateEvents).toEqual([
        {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
          resourceId: templateId,
          workspaceId: ids.wsA1,
          metadata: {
            format: "docx",
            status: "partial",
            unmatchedCount: 0,
            aiFieldErrorCount: 0,
            undecidedConditionCount: 1,
            entityId: createdEntityId,
          },
        },
      ]);

      // How the unset condition renders is unchanged (it reads as false);
      // the recorded status and the response are what make it visible.
      const savedWrite = fakeS3.requests.find(
        (request) => request.method === "PUT" && request.key !== s3Key,
      );
      const saved = fakeS3.objects.get(
        `${savedWrite?.bucket ?? ""}/${savedWrite?.key ?? ""}`,
      );
      const xml =
        (await (
          await JSZip.loadAsync(saved?.bytes ?? new Uint8Array())
        )
          .file("word/document.xml")
          ?.async("string")) ?? "";
      expect(xml).toContain("Preamble.");
      expect(xml).not.toContain("Consumer notice.");
      expect(xml).toContain("Business terms.");
    } finally {
      await testDb
        .delete(templateFills)
        .where(eq(templateFills.templateId, templateId));
      if (createdEntityId !== undefined) {
        await testDb
          .delete(entities)
          .where(
            and(
              eq(entities.id, asTestRaw(createdEntityId)),
              eq(entities.workspaceId, ids.wsA1),
            ),
          );
      }
      await testDb.delete(templates).where(eq(templates.id, templateId));
    }
  });
});
