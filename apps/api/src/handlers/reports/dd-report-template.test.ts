import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { JustificationContent } from "@/api/db/schema";
import type {
  FieldContent,
  PropertyContent,
  PropertyTool,
} from "@/api/db/schema-validators";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import type { AiFieldGenerator } from "@/api/handlers/docx/resolve-ai-fields";
import { resolveAiFields } from "@/api/handlers/docx/resolve-ai-fields";
import { isTemplateData } from "@/api/handlers/docx/types";
import type { QueryEntityResult } from "@/api/handlers/entities/query-entities";
import { buildExportColumns } from "@/api/handlers/views/table-export";
import { toSafeId } from "@/api/lib/branded-types";
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
const textPropertyContent: PropertyContent = { version: 1, type: "text" };
const verdictTool = (
  askPropertyId: string,
  severity: "blocker" | "high",
): PropertyTool => ({
  version: 1,
  type: "playbook-verdict",
  askPropertyId,
  rule: { kind: "positionMatch" },
  severity,
  tiers: { fallbacks: [], acceptableRules: [], notAcceptableRules: [] },
});

const properties = [
  {
    id: ASK_LAW,
    name: "Governing law",
    content: textPropertyContent,
    role: null,
    tool: aiTool,
  },
  {
    id: VERDICT_LAW,
    name: "Governing law verdict",
    content: textPropertyContent,
    role: null,
    tool: verdictTool(ASK_LAW, "high"),
  },
  {
    id: ASK_TERM,
    name: "Term",
    content: textPropertyContent,
    role: null,
    tool: aiTool,
  },
  {
    id: VERDICT_TERM,
    name: "Term verdict",
    content: textPropertyContent,
    role: null,
    tool: verdictTool(ASK_TERM, "blocker"),
  },
  {
    id: ASK_CAP,
    name: "Liability cap",
    content: textPropertyContent,
    role: null,
    tool: aiTool,
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
  listItemType: null,
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
      makeEntity(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "Non-Disclosure Agreement — Vendor",
        [
          field("a-law", ASK_LAW, text("Czech law")),
          field("v-law", VERDICT_LAW, select("deviation")),
          field("a-term", ASK_TERM, text("2 years")),
          field("v-term", VERDICT_TERM, select("compliant")),
          field("a-cap", ASK_CAP, text("EUR 1,000,000")),
        ],
      ),
      makeEntity(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "Master Services Agreement — Acme s.r.o.",
        [
          // Two findings at different severities: law (missing/high) and
          // term (deviation/blocker).
          field("b-law", ASK_LAW, text("New York law")),
          field("bv-law", VERDICT_LAW, select("missing")),
          field("b-term", ASK_TERM, text("5 years")),
          field("bv-term", VERDICT_TERM, select("deviation")),
          field("b-cap", ASK_CAP, text("Uncapped")),
        ],
      ),
      makeEntity(
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "Software Licence Agreement — Globex Ltd",
        [
          // A clean contract: every verdict compliant, so no risks.
          field("c-law", ASK_LAW, text("English law")),
          field("cv-law", VERDICT_LAW, select("compliant")),
          field("c-term", ASK_TERM, text("3 years")),
          field("cv-term", VERDICT_TERM, select("compliant")),
          field("c-cap", ASK_CAP, text("EUR 500,000")),
        ],
      ),
    ];

    // Only the NDA's Governing-law risk carries a quoted citation; the MSA's
    // two risks have none — proving the per-risk {{#if hasCitation}} gate.
    const justifications = new Map<string, JustificationContent>([
      [
        "a-law",
        {
          version: 1,
          blocks: [
            {
              kind: "docx-folio",
              fileFieldId: toSafeId<"field">("fld"),
              statements: [
                {
                  text: "stmt",
                  citations: [
                    {
                      blockId: "b1",
                      text: "Clause 12.1: governed by Czech law.",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    ]);

    const data = assembleReportData({
      entities,
      columns,
      properties,
      justificationByFieldId: justifications,
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
    expect(xml).toContain("Non-Disclosure Agreement — Vendor");
    expect(xml).toContain("Master Services Agreement — Acme s.r.o.");
    expect(xml).toContain("Software Licence Agreement — Globex Ltd");
    // Heading2 is numbered by the loop {{@index}}.
    expect(xml).toContain("1.");
    expect(xml).toContain("3.");
    // Field row-repeat rendered field labels/values.
    expect(xml).toContain("Governing law");
    expect(xml).toContain("Czech law");
    expect(xml).toContain("Liability cap");
    // Verdict column present because the view carries verdicts.
    expect(xml).toContain("Verdict");
    // Risk block rendered a deviation/missing finding.
    expect(xml).toContain("deviation");
    // Per-risk citation gating: exactly ONE risk (NDA's Governing law) carries
    // a citation, so "Citation:" renders exactly once — the MSA's two
    // citation-less risks render no dangling label.
    expect(xml.split("Citation:").length - 1).toBe(1);
    expect(xml).toContain("Clause 12.1: governed by Czech law.");
    // AI-drafted narrative present.
    expect(xml).toContain("Executive summary drafted by the stub.");
    expect(xml).toContain("Summary for contract 1 of 3.");
    // One label/value stats table (no header band): the base row plus the
    // verdict-gated breakdown rows.
    expect(xml).toContain("Contracts reviewed");
    expect(xml).toContain("Red flags");
    expect(xml).toContain("Blocker");
    expect(xml).not.toContain("Findings");

    // Annex — Review matrix: the row-repeat clones one row per contract and
    // renders each contract's consolidated "Label: value" summary cell.
    expect(xml).toContain("Annex — Review matrix");
    expect(xml).toContain("Governing law: Czech law");
    expect(xml).toContain("Liability cap: EUR 1,000,000");
  });

  test("aiNarrative=false drops the AI sections with no model calls or leftover markers", async () => {
    const columns = buildExportColumns(layout, properties);
    const entities = [
      makeEntity(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "Non-Disclosure Agreement — Vendor",
        [
          field("a-law", ASK_LAW, text("Czech law")),
          field("v-law", VERDICT_LAW, select("deviation")),
          field("a-term", ASK_TERM, text("2 years")),
          field("v-term", VERDICT_TERM, select("compliant")),
          field("a-cap", ASK_CAP, text("EUR 1,000,000")),
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
      aiNarrative: false,
    });

    // Mirror the worker's deterministic branch: it gates the AI generator on
    // `aiNarrative`, so with it off no generator is passed and resolveAiFields
    // is a no-op (the spy must never run).
    let aiCalls = 0;
    const spy: AiFieldGenerator = async () => {
      aiCalls += 1;
      return "should not be called";
    };
    const record = await resolveAiFields({
      values: data,
      fields: DD_REPORT_MANIFEST.fields,
      generate: data.aiNarrative ? spy : undefined,
    });
    if (!isTemplateData(record)) {
      throw new Error("assembled report data is not fillable template data");
    }

    const buffer = await getBuiltinReportTemplate("dd-report")?.loadBuffer();
    if (!buffer) {
      throw new Error("dd-report built-in template not found");
    }

    const result = await fillTemplate(buffer, record);

    expect(aiCalls).toBe(0);
    expect(result.structureErrors).toEqual([]);
    expect(result.unmatchedPlaceholders).toEqual([]);

    const xml = await readDocumentXml(result.buffer);
    // No literal directive/placeholder markers leaked into the output.
    expect(xml).not.toContain("{{");
    // Deterministic content still renders: the contract section, the field
    // table, and the stats line under the (non-empty) Executive Summary heading.
    expect(xml).toContain("Executive Summary");
    expect(xml).toContain("Contracts reviewed");
    expect(xml).toContain("Non-Disclosure Agreement — Vendor");
    expect(xml).toContain("Czech law");
  });

  test("plain view (no verdicts, no doc types) renders the no-Verdict table with no dangling labels", async () => {
    // A view with only ASK columns and no playbook: hasVerdicts is false.
    const bareProps = [
      {
        id: ASK_LAW,
        name: "Governing law",
        content: textPropertyContent,
        role: null,
        tool: aiTool,
      },
      {
        id: ASK_TERM,
        name: "Term",
        content: textPropertyContent,
        role: null,
        tool: aiTool,
      },
      {
        id: ASK_CAP,
        name: "Liability cap",
        content: textPropertyContent,
        role: null,
        tool: aiTool,
      },
    ];
    const bareLayout: Extract<ViewLayout, { type: "table" }> = {
      type: "table",
      version: 1,
      filters: [],
      sorts: [],
      hiddenProperties: [],
      columnOrder: [ASK_LAW, ASK_TERM, ASK_CAP],
      columnPinning: [],
    };
    const columns = buildExportColumns(bareLayout, bareProps);
    const entities = [
      makeEntity(
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "Consulting Agreement — Initech",
        [
          field("d-law", ASK_LAW, text("German law")),
          field("d-term", ASK_TERM, text("12 months")),
          field("d-cap", ASK_CAP, text("EUR 250,000")),
        ],
      ),
    ];

    const data = assembleReportData({
      entities,
      columns,
      properties: bareProps,
      justificationByFieldId: new Map(),
      docTypePropertyId: null,
      workspaceName: "Project Beacon",
      now: new Date("2026-07-02T00:00:00.000Z"),
      aiNarrative: false,
    });
    expect(data.hasVerdicts).toBe(false);

    if (!isTemplateData(data)) {
      throw new Error("assembled report data is not fillable template data");
    }

    const buffer = await getBuiltinReportTemplate("dd-report")?.loadBuffer();
    if (!buffer) {
      throw new Error("dd-report built-in template not found");
    }

    const result = await fillTemplate(buffer, data);

    expect(result.structureErrors).toEqual([]);
    expect(result.unmatchedPlaceholders).toEqual([]);

    const xml = await readDocumentXml(result.buffer);
    expect(xml).not.toContain("{{");
    // The no-Verdict field table variant rendered: no "Verdict" header, no
    // red-flag/severity stats rows (single-row stats variant), no citations,
    // and no dangling "Document type:" / "Risk level:".
    expect(xml).not.toContain("Verdict");
    expect(xml).not.toContain("Red flags");
    expect(xml).not.toContain("Citation");
    expect(xml).not.toContain("Document type:");
    expect(xml).not.toContain("Risk level:");
    // Deterministic content still present.
    expect(xml).toContain("Consulting Agreement — Initech");
    expect(xml).toContain("German law");
    expect(xml).toContain("Contracts reviewed");
  });
});
