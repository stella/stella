import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { JustificationContent } from "@/api/db/schema";
import type { FieldContent, PropertyTool } from "@/api/db/schema-validators";
import type { QueryEntityResult } from "@/api/handlers/entities/query-entities";
import { buildExportColumns } from "@/api/handlers/views/table-export";
import { toSafeId } from "@/api/lib/branded-types";
import { isStuckReportExport } from "@/api/lib/report-export-recovery";
import type { ViewLayout } from "@/api/lib/views-schema";

import {
  assembleReportData,
  isReportRowCountOverCap,
} from "./build-report-data";
import {
  buildReportDelivery,
  toExportErrorMessage,
} from "./report-export-queue";

// ── Fixture ids (real UUID shape; the no-UUID test asserts none leak) ────────
const ASK_LAW = "11111111-1111-4111-8111-111111111111";
const VERDICT_LAW = "22222222-2222-4222-8222-222222222222";
const ASK_TERM = "33333333-3333-4333-8333-333333333333";
const VERDICT_TERM = "44444444-4444-4444-8444-444444444444";
const DOC_TYPE = "55555555-5555-4555-8555-555555555555";
const NOTES = "66666666-6666-4666-8666-666666666666";
const ENTITY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTITY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const aiTool: PropertyTool = {
  version: 1,
  type: "ai-model",
  prompt: "extract",
};

const manualTool: PropertyTool = { version: 1, type: "manual-input" };

const verdictTool = (
  askPropertyId: string,
  severity: "blocker" | "high" | "medium" | "low",
): PropertyTool => ({
  version: 1,
  type: "playbook-verdict",
  askPropertyId,
  rule: { kind: "positionMatch" },
  severity,
  standard: {},
});

const properties = [
  { id: ASK_LAW, name: "Governing law", tool: aiTool },
  {
    id: VERDICT_LAW,
    name: "Governing law verdict",
    tool: verdictTool(ASK_LAW, "high"),
  },
  { id: ASK_TERM, name: "Term", tool: aiTool },
  {
    id: VERDICT_TERM,
    name: "Term verdict",
    tool: verdictTool(ASK_TERM, "blocker"),
  },
  { id: DOC_TYPE, name: "Document Type", tool: aiTool },
  {
    id: NOTES,
    name: "Notes",
    tool: manualTool,
  },
];

const text = (value: string): FieldContent => ({
  version: 1,
  type: "text",
  value,
});

const select = (value: string): FieldContent => ({
  version: 1,
  type: "single-select",
  value,
});

const field = (id: string, propertyId: string, content: FieldContent) => ({
  id,
  propertyId,
  entityId: "",
  content,
});

const makeEntity = (
  entityId: string,
  name: string,
  fields: QueryEntityResult["fields"],
): QueryEntityResult => ({
  entityId,
  kind: "document",
  name,
  parentId: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  createdBy: null,
  createdByImage: null,
  createdByDeletedAt: null,
  version: 1,
  updatedAt: null,
  status: null,
  priority: null,
  dueDate: null,
  agendaKind: "task",
  startAt: null,
  endAt: null,
  occurredAt: null,
  remindAt: null,
  allDay: false,
  timeZone: null,
  location: null,
  onlineMeetingUrl: null,
  availability: null,
  sensitivity: null,
  organizer: null,
  attendees: null,
  recurrence: null,
  agendaSource: "manual",
  externalSource: null,
  externalId: null,
  externalChangeKey: null,
  externalICalUid: null,
  readOnly: false,
  sortOrder: null,
  activeEditBy: null,
  fields,
  cellMetadata: [],
});

const tableLayout = (
  overrides: Partial<Extract<ViewLayout, { type: "table" }>> = {},
): Extract<ViewLayout, { type: "table" }> => ({
  type: "table",
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
  columnOrder: [],
  columnPinning: [],
  ...overrides,
});

const NOW = new Date("2026-07-02T10:00:00.000Z");

describe("assembleReportData", () => {
  test("honors column order and hidden properties; pairs verdict with ASK", () => {
    const layout = tableLayout({
      columnOrder: [ASK_TERM, ASK_LAW, NOTES],
      hiddenProperties: [NOTES],
    });
    const columns = buildExportColumns(layout, properties);
    const entity = makeEntity(ENTITY_A, "NDA", [
      field("f1", ASK_LAW, text("Czech law")),
      field("f2", VERDICT_LAW, select("deviation")),
      field("f3", ASK_TERM, text("2 years")),
      field("f4", VERDICT_TERM, select("compliant")),
      field("f5", DOC_TYPE, select("NDA")),
      field("f6", NOTES, text("hidden note")),
    ]);

    const data = assembleReportData({
      entities: [entity],
      columns,
      properties,
      justificationByFieldId: new Map(),
      docTypePropertyId: DOC_TYPE,
      workspaceName: "Acme M&A",
      now: NOW,
    });

    const contract = data.contracts[0];
    // Term before Governing law (columnOrder), Notes hidden, no verdict column.
    // The Document Type classifier column is EXCLUDED from the field rows (the
    // per-contract caption owns it; the annex summary re-adds a "Type:" prefix).
    expect(contract?.fields.map((f) => f.label)).toEqual([
      "Term",
      "Governing law",
    ]);
    expect(contract?.documentType).toBe("NDA");
    // The annex mirrors the field columns (no Document Type column) and keeps
    // the type as the first joined summary segment.
    expect(data.grid.columns.map((column) => column.label)).toEqual([
      "Term",
      "Governing law",
    ]);
    expect(data.grid.rows[0]?.summary.startsWith("Type: NDA · ")).toBe(true);
    // The view grades positions, so it carries verdicts; the contract has a
    // document type. Both gate template sections.
    expect(data.hasVerdicts).toBe(true);
    expect(contract?.hasDocumentType).toBe(true);
    expect(contract?.hasRiskLevel).toBe(true);
    // Governing law rides its verdict tier + severity; Term is compliant.
    const lawField = contract?.fields.find((f) => f.label === "Governing law");
    expect(lawField?.value).toBe("Czech law");
    expect(lawField?.verdict).toBe("deviation");
    expect(lawField?.severity).toBe("high");
  });

  test("derives risks from deviation/missing verdicts with rationale + citation", () => {
    const layout = tableLayout({ columnOrder: [ASK_LAW, ASK_TERM] });
    const columns = buildExportColumns(layout, properties);
    const justifications = new Map<string, JustificationContent>([
      [
        "vf-law",
        {
          version: 1,
          blocks: [
            {
              kind: "playbook-verdict",
              rationale: "Non-standard forum.",
              matched: "none",
            },
          ],
        },
      ],
      [
        "af-law",
        {
          version: 1,
          blocks: [
            {
              kind: "docx-folio",
              fileFieldId: toSafeId<"field">("fld"),
              statements: [
                {
                  text: "stmt",
                  citations: [{ blockId: "b1", text: "Clause 12.1 quoted." }],
                },
              ],
            },
          ],
        },
      ],
    ]);
    const entity = makeEntity(ENTITY_A, "MSA", [
      field("af-law", ASK_LAW, text("New York law")),
      field("vf-law", VERDICT_LAW, select("deviation")),
      field("af-term", ASK_TERM, text("5 years")),
      field("vf-term", VERDICT_TERM, select("missing")),
    ]);

    const data = assembleReportData({
      entities: [entity],
      columns,
      properties,
      justificationByFieldId: justifications,
      docTypePropertyId: null,
      workspaceName: "WS",
      now: NOW,
    });

    const contract = data.contracts[0];
    expect(contract?.hasRisks).toBe(true);
    expect(contract?.risks).toHaveLength(2);
    const lawRisk = contract?.risks.find((r) => r.issue === "Governing law");
    expect(lawRisk).toEqual({
      severity: "high",
      issue: "Governing law",
      verdict: "deviation",
      rationale: "Non-standard forum.",
      citation: "Clause 12.1 quoted.",
      hasCitation: true,
    });
    // The Term risk has no justification → empty citation, gated off.
    const termRisk = contract?.risks.find((r) => r.issue === "Term");
    expect(termRisk?.citation).toBe("");
    expect(termRisk?.hasCitation).toBe(false);
    // Worst severity among {high, blocker} is blocker.
    expect(contract?.riskLevel).toBe("blocker");
    // Stats roll up across contracts.
    expect(data.stats).toEqual({
      total: 1,
      redFlags: 2,
      bySeverity: { blocker: 1, high: 1, medium: 0, low: 0 },
    });
  });

  test("empty-playbook view yields empty risks and a valid report", () => {
    const layout = tableLayout({ columnOrder: [ASK_LAW] });
    // Only the ASK property; no verdict property present.
    const bare = [{ id: ASK_LAW, name: "Governing law", tool: aiTool }];
    const columns = buildExportColumns(layout, bare);
    const entity = makeEntity(ENTITY_A, "NDA", [
      field("f1", ASK_LAW, text("Czech law")),
    ]);

    const data = assembleReportData({
      entities: [entity],
      columns,
      properties: bare,
      justificationByFieldId: new Map(),
      docTypePropertyId: null,
      workspaceName: "WS",
      now: NOW,
    });

    const contract = data.contracts[0];
    expect(contract?.risks).toEqual([]);
    expect(contract?.hasRisks).toBe(false);
    expect(contract?.riskLevel).toBe("ok");
    // No playbook column → no verdicts, so the riskLevel is noise and gated off;
    // no document-type column was supplied either.
    expect(data.hasVerdicts).toBe(false);
    expect(contract?.hasRiskLevel).toBe(false);
    expect(contract?.hasDocumentType).toBe(false);
    expect(contract?.fields[0]).toEqual({
      label: "Governing law",
      value: "Czech law",
      verdict: "",
      severity: "",
    });
    expect(data.stats.redFlags).toBe(0);
  });

  test("no entity/property UUIDs leak into the AI-visible data object", () => {
    const layout = tableLayout({ columnOrder: [ASK_LAW, ASK_TERM] });
    const columns = buildExportColumns(layout, properties);
    const entities = [
      makeEntity(ENTITY_A, "NDA", [
        field("af-law", ASK_LAW, text("Czech law")),
        field("vf-law", VERDICT_LAW, select("deviation")),
      ]),
      makeEntity(ENTITY_B, "MSA", [
        field("af-law2", ASK_LAW, text("New York law")),
        field("vf-law2", VERDICT_LAW, select("compliant")),
      ]),
    ];

    const data = assembleReportData({
      entities,
      columns,
      properties,
      justificationByFieldId: new Map(),
      docTypePropertyId: DOC_TYPE,
      workspaceName: "WS",
      now: NOW,
    });

    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/iu);
    // Contracts are identified positionally.
    expect(data.contracts.map((c) => c.index)).toEqual([1, 2]);

    // The review-matrix annex is built from the same visible columns/rows and
    // must likewise carry no UUIDs (the serialized check above covers `grid`
    // too). Columns mirror the report columns (the Document Type classifier is
    // excluded; the summary carries it as a "Type:" prefix when present); rows
    // mirror the contracts.
    expect(data.grid.columns.map((column) => column.label)).toEqual([
      "Governing law",
      "Term",
      "Notes",
    ]);
    expect(data.grid.rows.map((row) => row.name)).toEqual(["NDA", "MSA"]);
    // Verdict folds into the cell value as a suffix; the summary pre-joins them.
    expect(data.grid.rows[0]?.cells[0]).toEqual({
      label: "Governing law",
      value: "Czech law (deviation)",
    });
    expect(data.grid.rows[0]?.summary).toContain("Governing law: Czech law");
  });
});

describe("isReportRowCountOverCap", () => {
  test("cap boundary", () => {
    expect(isReportRowCountOverCap(500)).toBe(false);
    expect(isReportRowCountOverCap(501)).toBe(true);
  });
});

describe("buildReportDelivery", () => {
  const docx = Buffer.from("PK docx bytes");
  const DOCX_MIME =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  test("docx passes the filled buffer through unchanged", async () => {
    let converted = false;
    const delivery = await buildReportDelivery({
      docxBuffer: docx,
      format: "docx",
      convertToPdfBuffer: async () => {
        converted = true;
        return Result.ok(new ArrayBuffer(0));
      },
    });
    if ("error" in delivery) {
      throw new Error("expected a docx delivery");
    }
    expect(delivery.ext).toBe("docx");
    expect(delivery.mimeType).toBe(DOCX_MIME);
    expect(Buffer.from(delivery.buffer).equals(docx)).toBe(true);
    // No Gotenberg round-trip for the native format.
    expect(converted).toBe(false);
  });

  test("pdf converts via the injected seam and names the artifact .pdf", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 converted");
    const delivery = await buildReportDelivery({
      docxBuffer: docx,
      format: "pdf",
      convertToPdfBuffer: async (input) => {
        // Receives the filled DOCX buffer.
        expect(Buffer.from(input).equals(docx)).toBe(true);
        return Result.ok(pdfBytes.buffer);
      },
    });
    if ("error" in delivery) {
      throw new Error("expected a pdf delivery");
    }
    expect(delivery.ext).toBe("pdf");
    expect(delivery.mimeType).toBe("application/pdf");
    expect(new TextDecoder().decode(delivery.buffer)).toBe(
      "%PDF-1.7 converted",
    );
  });

  test("pdf conversion failure yields a typed error string", async () => {
    const delivery = await buildReportDelivery({
      docxBuffer: docx,
      format: "pdf",
      convertToPdfBuffer: async () => Result.err(new Error("gotenberg down")),
    });
    expect("error" in delivery).toBe(true);
  });
});

describe("isStuckReportExport", () => {
  const now = new Date("2026-07-02T12:00:00.000Z");
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000);

  test("sweeps an old running row, leaves fresh rows alone", () => {
    // Old running row → orphaned by a dead worker; recover it.
    expect(
      isStuckReportExport(
        { status: "running", updatedAt: minutesAgo(45) },
        now,
      ),
    ).toBe(true);
    // Old queued row → never picked up (enqueue died); recover it too.
    expect(
      isStuckReportExport({ status: "queued", updatedAt: minutesAgo(31) }, now),
    ).toBe(true);
    // Fresh running row → still in flight; leave it.
    expect(
      isStuckReportExport({ status: "running", updatedAt: minutesAgo(5) }, now),
    ).toBe(false);
    // Terminal rows are never touched, however old.
    expect(
      isStuckReportExport(
        { status: "completed", updatedAt: minutesAgo(999) },
        now,
      ),
    ).toBe(false);
    expect(
      isStuckReportExport(
        { status: "failed", updatedAt: minutesAgo(999) },
        now,
      ),
    ).toBe(false);
  });
});

describe("toExportErrorMessage", () => {
  test("maps Error and strings, truncates", () => {
    expect(toExportErrorMessage(new Error("boom"))).toBe("boom");
    expect(toExportErrorMessage("plain")).toBe("plain");
    expect(
      toExportErrorMessage(toExportErrorMessage("x".repeat(2000))).length,
    ).toBe(1000);
  });
});
