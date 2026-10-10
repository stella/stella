import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { auditLogs, templateFills, templates } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import {
  createTemplateTools,
  FILL_TEMPLATE_TOOL_NAME,
} from "@/api/handlers/chat/tools/template-tools";
import { AUDIT_ACTION, createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import type {
  fillStoredTemplate,
  fillStoredTemplateWithTextStrict,
} from "@/api/lib/templates/template-fill-service";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { testDocxFile } from "@/api/tests/helpers/scanned-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let db: TestDatabase;
let ids: TestIds;
const createdTemplateIds: SafeId<"template">[] = [];

const RENDERED_TEXT = "Lease between ACME and Tenant.";

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (createdTemplateIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.resourceId, createdTemplateIds));
    await db
      .delete(templateFills)
      .where(inArray(templateFills.templateId, createdTemplateIds));
    await db.delete(templates).where(inArray(templates.id, createdTemplateIds));
  }
  await releaseRlsFixture();
});

const seedTemplate = async (): Promise<SafeId<"template">> => {
  const templateId = createSafeId<"template">();
  createdTemplateIds.push(templateId);
  await db.insert(templates).values({
    id: templateId,
    organizationId: ids.orgA,
    name: "Lease",
    fileName: "lease.docx",
    s3Key: `test/${templateId}.docx`,
    sizeBytes: 1024,
    createdBy: ids.userA1,
  });
  return templateId;
};

const scopedDb = () =>
  asTestRaw<ScopedDb>(createScopedDb(db, [], ids.orgA, ids.userA1));
const safeDb = () =>
  asTestRaw<SafeDb>(createSafeDb(db, [], ids.orgA, ids.userA1));

const recorder = () =>
  createAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: null,
    userId: ids.userA1,
    request: new Request("https://example.test/templates"),
    server: null,
  });

/** Fails at the last write of the recording transaction, after the use bump
 *  and the fill row, so a partial commit would leave both behind. */
const failingRecorder: AuditRecorder = async () => {
  await Promise.resolve();
  throw new Error("audit write refused");
};

type FillOutcome =
  | { type: "returned"; text: unknown }
  | { type: "failed"; error: unknown };

type Transport = {
  name: string;
  fill: (options: {
    templateId: SafeId<"template">;
    recordAuditEvent: AuditRecorder;
  }) => Promise<FillOutcome>;
  expectFailure: (error: unknown) => void;
};

const fillOverChat: Transport["fill"] = async ({
  templateId,
  recordAuditEvent,
}) => {
  const fakeFill: typeof fillStoredTemplate = async (options) => {
    expect(options.useRecording).toBe("caller");
    return await Promise.resolve({
      text: RENDERED_TEXT,
      unmatchedPlaceholders: [],
      unusedValues: [],
      structureErrors: [],
      aiFieldErrors: [],
      conditionDecisions: [],
      clauseWarnings: [],
    });
  };
  const tool = createTemplateTools({
    scopedDb: scopedDb(),
    safeDb: safeDb(),
    organizationId: ids.orgA,
    modelAdmission: testModelAdmission(ids.orgA),
    userId: ids.userA1,
    orgAIConfig: null,
    managedAIResidency: "eu",
    recordAuditEvent,
    thirdPartyBoundary: { type: "raw" },
    dependencies: { fillStoredTemplate: fakeFill },
  })[FILL_TEMPLATE_TOOL_NAME];
  const execute = tool.execute ?? panic("fill_template is missing execute");
  return await Promise.resolve()
    .then(
      async () =>
        await execute(
          { templateId, values: { "tenant.name": "ACME" } },
          { emitCustomEvent: () => undefined },
        ),
    )
    .then(
      (output: unknown): FillOutcome => ({
        type: "returned",
        text:
          typeof output === "object" && output !== null && "text" in output
            ? output.text
            : undefined,
      }),
      (error: unknown): FillOutcome => ({ type: "failed", error }),
    );
};

const fillOverMcp: Transport["fill"] = async ({
  templateId,
  recordAuditEvent,
}) => {
  const fakeFill: typeof fillStoredTemplateWithTextStrict = async (options) => {
    expect(options.useRecording).toBe("caller");
    return await Promise.resolve({
      templateName: "Lease",
      fileName: "lease.docx",
      file: testDocxFile(Buffer.from("PK filled docx bytes")),
      text: RENDERED_TEXT,
      unmatchedPlaceholders: [],
      unusedValues: [],
      structureErrors: [],
      aiFieldErrors: [],
      conditionDecisions: [],
      clauseWarnings: [],
    });
  };
  const result = await handleMcpToolCall({
    args: {
      template_id: templateId,
      values: { "tenant.name": "ACME" },
      output_mode: "docx",
    },
    context: {
      accessibleWorkspaceIds: [],
      accessibleWorkspaceIdSet: new Set(),
      accessibleWorkspaceStatusById: new Map(),
      accessibleWorkspaces: [],
      grantedScopes: [],
      memberRole: "owner",
      organizationId: ids.orgA,
      recordAuditEvent,
      safeDb: safeDb(),
      scopedDb: scopedDb(),
      userId: ids.userA1,
      userEmail: "owner@example.test",
      testDependencies: { fillStoredTemplateWithTextStrict: fakeFill },
    },
    toolName: "fill_template",
  });
  const item = result.content.at(0);
  const payload: unknown =
    item?.type === "text" ? JSON.parse(item.text) : undefined;
  if (result.isError === true) {
    return { type: "failed", error: payload };
  }
  return {
    type: "returned",
    text:
      typeof payload === "object" && payload !== null && "text" in payload
        ? payload.text
        : undefined,
  };
};

const transports: Transport[] = [
  {
    name: "chat",
    fill: fillOverChat,
    expectFailure: (error) => {
      expect(ChatToolError.is(error)).toBe(true);
      expect(error).toMatchObject({ kind: "server-defect" });
    },
  },
  {
    name: "MCP",
    fill: fillOverMcp,
    expectFailure: (error) => {
      expect(error).toMatchObject({ error: { code: "internal_error" } });
      expect(JSON.stringify(error)).not.toContain(RENDERED_TEXT);
    },
  },
];

const readRecords = async (templateId: SafeId<"template">) => {
  const [template] = await db
    .select({ useCount: templates.useCount })
    .from(templates)
    .where(eq(templates.id, templateId));
  const fills = await db
    .select({ format: templateFills.format, status: templateFills.status })
    .from(templateFills)
    .where(eq(templateFills.templateId, templateId));
  const audits = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.resourceId, templateId),
        eq(auditLogs.action, AUDIT_ACTION.EXECUTE),
      ),
    );
  return {
    useCount: template?.useCount ?? panic("seeded template is missing"),
    fills: fills.length,
    audits: audits.length,
  };
};

describe.each(transports)(
  "fill_template over $name",
  ({ fill, expectFailure }) => {
    test("returns the text only after recording use, fill and audit once", async () => {
      const templateId = await seedTemplate();

      const outcome = await fill({ templateId, recordAuditEvent: recorder() });

      expect(outcome).toEqual({ type: "returned", text: RENDERED_TEXT });
      expect(await readRecords(templateId)).toEqual({
        useCount: 1,
        fills: 1,
        audits: 1,
      });
    });

    test("fails without the text and writes nothing when recording fails", async () => {
      const templateId = await seedTemplate();

      const outcome = await fill({
        templateId,
        recordAuditEvent: failingRecorder,
      });

      if (outcome.type !== "failed") {
        throw new Error("expected the fill to fail");
      }
      expectFailure(outcome.error);
      expect(await readRecords(templateId)).toEqual({
        useCount: 0,
        fills: 0,
        audits: 0,
      });
    });
  },
);
