import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { FillDiagnostics } from "@/api/lib/templates/template-fill-completion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { recordTemplateFill } from "./record-use";

const EMPTY_DIAGNOSTICS: FillDiagnostics = {
  unmatchedPlaceholders: [],
  aiFieldErrors: [],
  undecidedConditions: [],
  clauseWarnings: [],
  structureErrors: [],
  unusedValues: [],
  unrestoredFields: [],
};

/** Records what the fill row and the audit event were written with. */
const record = async (diagnostics: FillDiagnostics) => {
  const rows: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const tx = asTestRaw<Transaction>({
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        rows.push(row);
        await Promise.resolve();
      },
    }),
  });
  const recordAuditEvent: AuditRecorder = async (_tx, event) => {
    for (const each of Array.isArray(event) ? event : [event]) {
      audits.push(each.metadata ?? {});
    }
    await Promise.resolve();
  };
  await recordTemplateFill({
    tx,
    templateId: toSafeId<"template">("tmpl_1"),
    organizationId: toSafeId<"organization">("org_1"),
    userId: toSafeId<"user">("user_1"),
    format: "text",
    diagnostics,
    recordAuditEvent,
  });
  return { row: rows.at(0), audit: audits.at(0) };
};

describe("recordTemplateFill status", () => {
  test("an undecided AI condition records the fill as partial", async () => {
    const { row, audit } = await record({
      ...EMPTY_DIAGNOSTICS,
      undecidedConditions: [
        {
          path: "is_consumer",
          label: "Consumer contract",
          state: "undecided",
          reason: "failed",
        },
      ],
    });
    expect(row).toMatchObject({
      status: "partial",
      unmatchedCount: 0,
      unusedCount: 0,
      structureErrors: null,
    });
    expect(audit).toMatchObject({
      status: "partial",
      unmatchedCount: 0,
      aiFieldErrorCount: 0,
      undecidedConditionCount: 1,
    });
  });

  test("a clause kept with literal directives records the fill as a success (informational)", async () => {
    const { row } = await record({
      ...EMPTY_DIAGNOSTICS,
      clauseWarnings: [
        {
          code: "CLAUSE_LEGACY_DIRECTIVES",
          clauseName: "Terms",
          version: 2,
          message:
            "Clause Terms version 2 retains literal legacy directive markers.",
          issues: [],
        },
      ],
    });
    expect(row).toMatchObject({ status: "success" });
  });

  test("a directive the renderer could not apply records the fill as partial", async () => {
    const { row } = await record({
      ...EMPTY_DIAGNOSTICS,
      structureErrors: [
        { message: "Unclosed if", paragraphIndex: 0, directive: "{% if x %}" },
      ],
    });
    expect(row).toMatchObject({ status: "partial" });
  });

  test("only unused values keep the fill a success", async () => {
    const { row, audit } = await record({
      ...EMPTY_DIAGNOSTICS,
      unusedValues: ["extra"],
    });
    expect(row).toMatchObject({ status: "success", unusedCount: 1 });
    expect(audit).toMatchObject({ status: "success" });
  });
});

/** A transaction and audit recorder that keep what they were given. */
const recording = () => {
  const rows: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const tx = asTestRaw<Transaction>({
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        rows.push(row);
        await Promise.resolve();
      },
    }),
  });
  const recordAuditEvent: AuditRecorder = async (_tx, event) => {
    for (const each of Array.isArray(event) ? event : [event]) {
      events.push({ ...each });
    }
    await Promise.resolve();
  };
  return { rows, events, tx, recordAuditEvent };
};

const BLOCKED: FillDiagnostics = {
  ...EMPTY_DIAGNOSTICS,
  unmatchedPlaceholders: ["party"],
  aiFieldErrors: [
    {
      fieldPath: "summary",
      valuePath: "summary",
      itemIndex: null,
      reason: "generation-failed",
      message: "AI could not adapt this value.",
    },
  ],
  undecidedConditions: [
    { path: "is_consumer", label: "", state: "undecided", reason: "failed" },
  ],
  unusedValues: ["extra"],
};

describe("recordTemplateFill audit", () => {
  test("a library download is audited as a download with every count", async () => {
    const { rows, events, tx, recordAuditEvent } = recording();
    await recordTemplateFill({
      tx,
      templateId: toSafeId<"template">("tmpl_1"),
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      format: "pdf",
      diagnostics: BLOCKED,
      recordAuditEvent,
      auditAction: AUDIT_ACTION.DOWNLOAD,
    });
    expect(rows).toEqual([
      {
        organizationId: "org_1",
        templateId: "tmpl_1",
        userId: "user_1",
        format: "pdf",
        status: "partial",
        unmatchedCount: 1,
        unusedCount: 1,
        structureErrors: null,
      },
    ]);
    expect(events).toEqual([
      {
        action: AUDIT_ACTION.DOWNLOAD,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: "tmpl_1",
        workspaceId: null,
        metadata: {
          format: "pdf",
          status: "partial",
          unmatchedCount: 1,
          aiFieldErrorCount: 1,
          undecidedConditionCount: 1,
        },
      },
    ]);
  });

  test("a fill into a matter is executed there and names the created document", async () => {
    const { events, tx, recordAuditEvent } = recording();
    await recordTemplateFill({
      tx,
      templateId: toSafeId<"template">("tmpl_1"),
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      workspaceId: toSafeId<"workspace">("ws_1"),
      entityId: toSafeId<"entity">("entity_1"),
      format: "docx",
      diagnostics: EMPTY_DIAGNOSTICS,
      recordAuditEvent,
    });
    expect(events).toEqual([
      {
        action: AUDIT_ACTION.EXECUTE,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: "tmpl_1",
        workspaceId: "ws_1",
        metadata: {
          format: "docx",
          status: "success",
          unmatchedCount: 0,
          aiFieldErrorCount: 0,
          undecidedConditionCount: 0,
          entityId: "entity_1",
        },
      },
    ]);
  });

  test("an uploaded template records a row without a template and no audit event", async () => {
    const { rows, tx } = recording();
    await recordTemplateFill({
      tx,
      templateId: null,
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      format: "docx",
      diagnostics: BLOCKED,
    });
    expect(rows).toEqual([
      {
        organizationId: "org_1",
        userId: "user_1",
        format: "docx",
        status: "partial",
        unmatchedCount: 1,
        unusedCount: 1,
        structureErrors: null,
      },
    ]);
  });
});
