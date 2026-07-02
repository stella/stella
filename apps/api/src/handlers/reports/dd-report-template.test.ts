import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { FieldContent, PropertyTool } from "@/api/db/schema-validators";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import type { AiFieldGenerator } from "@/api/handlers/docx/resolve-ai-fields";
import { resolveAiFields } from "@/api/handlers/docx/resolve-ai-fields";
import { isTemplateData } from "@/api/handlers/docx/types";
import type { QueryEntityResult } from "@/api/handlers/entities/query-entities";
import { buildExportColumns } from "@/api/handlers/views/table-export";
import type { ViewLayout } from "@/api/lib/views-schema";

import { assembleReportData } from "./build-report-data";
import {
  DD_REPORT_MANIFEST,
  getBuiltinReportTemplate,
} from "./builtin-templates";

const ASK_LAW = "11111111-1111-4111-8111-111111111111";
const VERDICT_LAW = "22222222-2222-4222-8222-222222222222";
const ASK_TERM = "33333333-3333-4333-8333-333333333333";
const VERDICT_TERM = "44444444-4444-4444-8444-444444444444";
const ASK_CAP = "77777777-7777-4777-8777-777777777777";

const aiTool: PropertyTool = { version: 1, type: "ai-model", prompt: "x" };
const verdictTool = (
  askPropertyId: string,
  severity: "blocker" | "high",
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
  { id: ASK_CAP, name: "Liability cap", tool: aiTool },
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

const layout: Extract<ViewLayout, { type: "table" }> = {
  type: "table",
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
  columnOrder: [ASK_LAW, ASK_TERM, ASK_CAP],
  columnPinning: [],
};

// Deterministic stub: top-level -> exec summary; per-item -> a per-contract line.
const stubGenerate: AiFieldGenerator = async ({ item }) =>
  item
    ? `Summary for contract ${item.index} of ${item.count}.`
    : "Executive summary drafted by the stub.";

const readDocumentXml = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  return (await zip.file("word/document.xml")?.async("string")) ?? "";
};

describe("Due Diligence Report built-in template", () => {
  test("fills end-to-end with zero structure errors and no unmatched placeholders", async () => {
    const columns = buildExportColumns(layout, properties);
    const entities = [
      makeEntity("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "NDA with Vendor", [
        field("a-law", ASK_LAW, text("Czech law")),
        field("v-law", VERDICT_LAW, select("deviation")),
        field("a-term", ASK_TERM, text("2 years")),
        field("v-term", VERDICT_TERM, select("compliant")),
        field("a-cap", ASK_CAP, text("EUR 1,000,000")),
      ]),
      makeEntity(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "Master Services Agreement",
        [
          field("b-law", ASK_LAW, text("New York law")),
          field("bv-law", VERDICT_LAW, select("missing")),
          field("b-term", ASK_TERM, text("5 years")),
          field("bv-term", VERDICT_TERM, select("deviation")),
          field("b-cap", ASK_CAP, text("Uncapped")),
        ],
      ),
    ];

    const data = assembleReportData({
      entities,
      columns,
      properties,
      justificationByFieldId: new Map(),
      docTypePropertyId: null,
      workspaceName: "Project Atlas",
      now: new Date("2026-07-02T00:00:00.000Z"),
    });

    // AI fields drafted exactly as the fill pipeline would (execSummary +
    // per-contract summary), using the stub generator.
    const record = await resolveAiFields({
      values: data,
      fields: DD_REPORT_MANIFEST.fields,
      generate: stubGenerate,
    });
    if (!isTemplateData(record)) {
      throw new Error("assembled report data is not fillable template data");
    }

    const buffer = await getBuiltinReportTemplate("dd-report")?.loadBuffer();
    if (!buffer) {
      throw new Error("dd-report built-in template not found");
    }

    const result = await fillTemplate(buffer, record);

    expect(result.structureErrors).toEqual([]);
    expect(result.unmatchedPlaceholders).toEqual([]);

    const xml = await readDocumentXml(result.buffer);
    // Contract sections cloned per entity.
    expect(xml).toContain("NDA with Vendor");
    expect(xml).toContain("Master Services Agreement");
    // Field row-repeat rendered field labels/values.
    expect(xml).toContain("Governing law");
    expect(xml).toContain("Czech law");
    expect(xml).toContain("Liability cap");
    // Risk block rendered a deviation/missing finding.
    expect(xml).toContain("deviation");
    expect(xml).toContain("Citation:");
    // AI-drafted narrative present.
    expect(xml).toContain("Executive summary drafted by the stub.");
    expect(xml).toContain("Summary for contract 1 of 2.");
    // Stats line rendered (the {{stats.total}} value lands in its own run).
    expect(xml).toContain("Contracts reviewed: ");

    // Annex — Review matrix: the row-repeat clones one row per contract and
    // renders each contract's consolidated "Label: value" summary cell.
    expect(xml).toContain("Annex — Review matrix");
    expect(xml).toContain("Governing law: Czech law");
    expect(xml).toContain("Liability cap: EUR 1,000,000");
  });
});
