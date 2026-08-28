import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { JustificationContent, VerdictMatchedRef } from "@/api/db/schema";
import type {
  FieldContent,
  PropertyContent,
  PropertyTool,
} from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import type { QueryEntityResult } from "@/api/lib/entities/query-entities";
import { isStuckReportExport } from "@/api/lib/report-export-recovery";
import type { ViewLayout } from "@/api/lib/views-schema";
import { buildExportColumns } from "@/api/lib/views/export-columns";

import type { ReportJustification } from "./build-report-data";
import {
  assembleReportData,
  findDocTypePropertyId,
  isReportRowCountOverCap,
  reportCitationKey,
  reviewDecisionKey,
} from "./build-report-data";
import {
  buildReportDelivery,
  toExportErrorMessage,
} from "./report-export-queue";
import type { GradedPosition } from "./report-findings";

// ── Fixture ids (real UUID shape; the no-UUID test asserts none leak) ────────
const ASK_LAW = "11111111-1111-4111-8111-111111111111";
const VERDICT_LAW = "22222222-2222-4222-8222-222222222222";
const ASK_TERM = "33333333-3333-4333-8333-333333333333";
const VERDICT_TERM = "44444444-4444-4444-8444-444444444444";
const DOC_TYPE = "55555555-5555-4555-8555-555555555555";
const NOTES = "66666666-6666-4666-8666-666666666666";
const ENTITY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTITY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FILE_FIELD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JUSTIFICATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SOURCE_LAW = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SOURCE_TERM = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/iu;

const aiTool: PropertyTool = {
  version: 1,
  type: "ai-model",
  prompt: "extract",
};

const manualTool: PropertyTool = { version: 1, type: "manual-input" };
const textPropertyContent: PropertyContent = { version: 1, type: "text" };
const docTypePropertyContent: PropertyContent = {
  version: 1,
  type: "single-select",
  options: [{ value: "NDA", color: "blue" }],
  fallback: null,
};

const verdictTool = (
  askPropertyId: string,
  severity: "blocker" | "high" | "medium" | "low",
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
    playbookSourceId: null,
    tool: aiTool,
  },
  {
    id: VERDICT_LAW,
    name: "Governing law verdict",
    content: docTypePropertyContent,
    role: null,
    playbookSourceId: null,
    tool: verdictTool(ASK_LAW, "high"),
  },
  {
    id: ASK_TERM,
    name: "Term",
    content: textPropertyContent,
    role: null,
    playbookSourceId: null,
    tool: aiTool,
  },
  {
    id: VERDICT_TERM,
    name: "Term verdict",
    content: docTypePropertyContent,
    role: null,
    playbookSourceId: null,
    tool: verdictTool(ASK_TERM, "blocker"),
  },
  {
    id: DOC_TYPE,
    name: "Document Type",
    content: docTypePropertyContent,
    role: null,
    playbookSourceId: null,
    tool: aiTool,
  },
  {
    id: NOTES,
    name: "Notes",
    content: textPropertyContent,
    role: null,
    playbookSourceId: null,
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
  cellMetadata: QueryEntityResult["cellMetadata"] = [],
): QueryEntityResult => ({
  entityId,
  kind: "document",
  name,
  parentId: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  createdBy: null,
  createdByUserId: null,
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
  cellMetadata,
});

const lockedCell = (
  propertyId: string,
): QueryEntityResult["cellMetadata"][number] => ({
  propertyId,
  metadata: { version: 1, manualFlags: [], locked: true },
});

const tableLayout = (
  overrides: Partial<Extract<ViewLayout, { type: "table" }>> = {},
): Extract<ViewLayout, { type: "table" }> => ({
  type: "table",
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
  columnOrder: [],
  columnPinning: [],
  ...overrides,
});

/** Wrap justification content as the row shape the assembler reads. */
const justification = (
  id: string,
  content: JustificationContent,
): ReportJustification => ({ id, content });

const NOW = new Date("2026-07-02T10:00:00.000Z");

describe("assembleReportData", () => {
  test("honors column order and hidden properties; pairs verdict with ASK", () => {
    const layout = tableLayout({
      columnOrder: [ASK_TERM, ASK_LAW, NOTES],
      hiddenProperties: [NOTES],
      calculations: [],
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

    const { data } = assembleReportData({
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

  test("resolves the document type classifier by role before name", () => {
    const localizedProperties = properties.map((property) =>
      property.id === DOC_TYPE
        ? {
            ...property,
            name: "Type de document",
            role: "document-type-classifier" as const,
          }
        : property,
    );

    expect(findDocTypePropertyId(localizedProperties)).toBe(DOC_TYPE);
  });

  test("ignores role-tagged classifiers with the wrong content shape", () => {
    const malformed = {
      id: DOC_TYPE,
      name: "Type de document",
      content: textPropertyContent,
      role: "document-type-classifier" as const,
      playbookSourceId: null,
      tool: aiTool,
    };
    const fallback = {
      id: NOTES,
      name: "Document Type",
      content: docTypePropertyContent,
      role: null,
      playbookSourceId: null,
      tool: aiTool,
    };

    expect(findDocTypePropertyId([malformed, fallback])).toBe(NOTES);
  });

  test("derives risks from deviation/missing verdicts with rationale + citation", () => {
    const layout = tableLayout({ columnOrder: [ASK_LAW, ASK_TERM] });
    const columns = buildExportColumns(layout, properties);
    const justifications = new Map<string, ReportJustification>([
      [
        "vf-law",
        justification("j-vf-law", {
          version: 1,
          blocks: [
            {
              kind: "playbook-verdict",
              rationale: "Non-standard forum.",
            },
          ],
        }),
      ],
      [
        "af-law",
        justification("j-af-law", {
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
                      citationStatus: "verified",
                      blockId: "b1",
                      text: "Clause 12.1 quoted.",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ],
    ]);
    const entity = makeEntity(ENTITY_A, "MSA", [
      field("af-law", ASK_LAW, text("New York law")),
      field("vf-law", VERDICT_LAW, select("deviation")),
      field("af-term", ASK_TERM, text("5 years")),
      field("vf-term", VERDICT_TERM, select("missing")),
    ]);

    const { data } = assembleReportData({
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
    const bare = [
      {
        id: ASK_LAW,
        name: "Governing law",
        content: textPropertyContent,
        role: null,
        playbookSourceId: null,
        tool: aiTool,
      },
    ];
    const columns = buildExportColumns(layout, bare);
    const entity = makeEntity(ENTITY_A, "NDA", [
      field("f1", ASK_LAW, text("Czech law")),
    ]);

    const { data } = assembleReportData({
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

    const { data, links } = assembleReportData({
      entities,
      columns,
      properties,
      justificationByFieldId: new Map([
        [
          "af-law",
          justification(JUSTIFICATION_ID, {
            version: 1,
            blocks: [
              {
                kind: "docx-folio",
                fileFieldId: toSafeId<"field">(FILE_FIELD_ID),
                statements: [
                  {
                    text: "stmt",
                    citations: [
                      {
                        citationStatus: "verified",
                        blockId: "b1",
                        text: "Clause 12.1 quoted.",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        ],
      ]),
      docTypePropertyId: DOC_TYPE,
      workspaceName: "WS",
      now: NOW,
    });

    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(UUID_PATTERN);
    // Contracts are identified positionally.
    expect(data.contracts.map((c) => c.index)).toEqual([1, 2]);

    // The link index is the ONLY place the source ids live: the NDA's one
    // finding (contract 1, finding 1) has one citation, and its link resolves
    // to the entity, the cited file field and the justification row.
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]?.citations).toHaveLength(1);
    expect([...links.citations.keys()]).toEqual([
      reportCitationKey({
        contractIndex: 1,
        findingIndex: 1,
        citationIndex: 1,
      }),
    ]);
    expect(links.citations.get("1:1:1")).toEqual({
      entityId: ENTITY_A,
      fileFieldId: FILE_FIELD_ID,
      justificationId: JUSTIFICATION_ID,
    });
    for (const id of [ENTITY_A, FILE_FIELD_ID, JUSTIFICATION_ID]) {
      expect(id).toMatch(UUID_PATTERN);
    }

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
    // The cell keeps verdict and value apart; the summary folds the verdict in
    // as a suffix.
    expect(data.grid.rows[0]?.cells[0]).toEqual({
      label: "Governing law",
      value: "Czech law",
      verdict: "deviation",
      severity: "high",
    });
    expect(data.grid.rows[0]?.summary).toContain(
      "Governing law: Czech law (deviation)",
    );
  });
});

describe("assembleReportData findings", () => {
  // Verdict columns bound to playbook positions (the ASK side carries the same
  // sourceId in production; only the verdict side is read).
  const lawVerdictTool: PropertyTool = {
    version: 1,
    type: "playbook-verdict",
    askPropertyId: ASK_LAW,
    rule: { kind: "positionMatch" },
    severity: "high",
    tiers: {
      ideal: "Governed by Czech law.",
      fallbacks: [],
      acceptableRules: [],
      notAcceptableRules: [],
    },
  };
  const gradedProperties = properties.map((property) => {
    switch (property.id) {
      case VERDICT_LAW:
        return {
          id: property.id,
          name: property.name,
          content: property.content,
          role: property.role,
          playbookSourceId: SOURCE_LAW,
          tool: lawVerdictTool,
        };
      case VERDICT_TERM:
        return {
          id: property.id,
          name: property.name,
          content: property.content,
          role: property.role,
          playbookSourceId: SOURCE_TERM,
          tool: property.tool,
        };
      default:
        return property;
    }
  });

  const lawPosition: GradedPosition = {
    mode: "graded",
    sourceId: SOURCE_LAW,
    issue: "Governing law",
    severity: "high",
    ask: { mode: "auto" },
    tiers: {
      acceptable: { rules: [] },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
    guidance: "Prefer Czech law.",
    negotiation: {
      rationale: "Forum risk.",
      talkingPoints: ["Offer EU-member law."],
    },
    enabled: true,
  };

  const verdictJustification = (
    rationale: string,
    matchedRef?: VerdictMatchedRef,
  ): ReportJustification =>
    justification("j-verdict", {
      version: 1,
      blocks: [
        matchedRef
          ? { kind: "playbook-verdict", rationale, matchedRef }
          : { kind: "playbook-verdict", rationale },
      ],
    });

  const assemble = (
    entities: QueryEntityResult[],
    justificationByFieldId: Map<string, ReportJustification>,
    reviewDecisionByKey = new Map<string, "open" | "accepted" | "dismissed">(),
  ) =>
    assembleReportData({
      entities,
      columns: buildExportColumns(
        tableLayout({ columnOrder: [ASK_LAW, ASK_TERM] }),
        gradedProperties,
      ),
      properties: gradedProperties,
      justificationByFieldId,
      positionBySourceId: new Map([[SOURCE_LAW, lawPosition]]),
      reviewDecisionByKey,
      docTypePropertyId: DOC_TYPE,
      workspaceName: "WS",
      now: NOW,
    });

  test("orders findings blocker→low then by contract, and groups worst type first", () => {
    // NDA (contract 1): high law deviation. MSA (2): blocker term missing +
    // high law deviation. Lease (3, unclassified): low nothing; term missing.
    const entities = [
      makeEntity(ENTITY_A, "NDA", [
        field("a-law", ASK_LAW, text("NY law")),
        field("a-vlaw", VERDICT_LAW, select("deviation")),
        field("a-term", ASK_TERM, text("2y")),
        field("a-vterm", VERDICT_TERM, select("compliant")),
        field("a-type", DOC_TYPE, select("NDA")),
      ]),
      makeEntity(ENTITY_B, "MSA", [
        field("b-law", ASK_LAW, text("NY law")),
        field("b-vlaw", VERDICT_LAW, select("deviation")),
        field("b-vterm", VERDICT_TERM, select("missing")),
        field("b-type", DOC_TYPE, select("MSA")),
      ]),
      makeEntity("cccccccc-0000-4000-8000-000000000003", "Lease", [
        field("c-vterm", VERDICT_TERM, select("missing")),
      ]),
    ];
    const { data } = assemble(entities, new Map());

    expect(
      data.findings.map((f) => [f.severity, f.contractIndex, f.issue]),
    ).toEqual([
      ["blocker", 2, "Term"],
      ["blocker", 3, "Term"],
      ["high", 1, "Governing law"],
      ["high", 2, "Governing law"],
    ]);
    // MSA (2 flags) before NDA and the unclassified Lease (1 each); ties break
    // on the raw type, "" sorting first and left raw for the renderer.
    expect(data.groups.map((g) => [g.documentType, g.stats.redFlags])).toEqual([
      ["MSA", 2],
      ["", 1],
      ["NDA", 1],
    ]);
    expect(data.groups[0]?.contracts.map((c) => c.index)).toEqual([2]);
    expect(data.groups[0]?.findings.map((f) => f.severity)).toEqual([
      "blocker",
      "high",
    ]);
    expect(data.groups[0]?.stats).toEqual({
      total: 1,
      redFlags: 2,
      bySeverity: { blocker: 1, high: 1, medium: 0, low: 0 },
    });
    // Position enrichment + tier snapshot; the Term position is unknown → "".
    const law = data.findings.find((f) => f.issue === "Governing law");
    expect(law?.guidance).toBe("Prefer Czech law.");
    expect(law?.idealText).toBe("Governed by Czech law.");
    expect(law?.negotiation).toEqual({
      rationale: "Forum risk.",
      talkingPoints: ["Offer EU-member law."],
      escalation: "",
    });
    expect(law?.hasNegotiation).toBe(true);
    const term = data.findings.find((f) => f.issue === "Term");
    expect(term?.guidance).toBe("");
    expect(term?.idealText).toBe("");
    expect(term?.hasNegotiation).toBe(false);
    // Every contract's risks are the projection of its findings (risks keep
    // column order, which is the finding's index within the contract).
    for (const contract of data.contracts) {
      const own = data.findings
        .filter((f) => f.contractIndex === contract.index)
        .sort((a, b) => a.findingIndex - b.findingIndex);
      expect(contract.risks.map((r) => r.issue)).toEqual(
        own.map((f) => f.issue),
      );
    }
  });

  test("maps the verdict's matchedRef for fallback and red line", () => {
    const entities = [
      makeEntity(ENTITY_A, "NDA", [
        field("a-vlaw", VERDICT_LAW, select("deviation")),
        field("a-vterm", VERDICT_TERM, select("missing")),
      ]),
    ];
    const { data } = assemble(
      entities,
      new Map([
        [
          "a-vlaw",
          verdictJustification("Violates red line.", {
            kind: "redLine",
            ruleId: "rule-1",
            text: "No non-EU law.",
          }),
        ],
        [
          "a-vterm",
          verdictJustification("Matches alt.", {
            kind: "fallback",
            label: "Alt B",
            text: "3-year term.",
          }),
        ],
      ]),
    );
    const law = data.findings.find((f) => f.issue === "Governing law");
    expect(law?.rationale).toBe("Violates red line.");
    expect(law?.matchedRef).toEqual({
      kind: "redLine",
      label: "",
      text: "No non-EU law.",
    });
    const term = data.findings.find((f) => f.issue === "Term");
    expect(term?.matchedRef).toEqual({
      kind: "fallback",
      label: "Alt B",
      text: "3-year term.",
    });
  });

  test("keeps unverified docx citations ungrounded and never quotes them", () => {
    const entities = [
      makeEntity(ENTITY_A, "NDA", [
        field("a-law", ASK_LAW, text("NY law")),
        field("a-vlaw", VERDICT_LAW, select("deviation")),
      ]),
    ];
    const { data } = assemble(
      entities,
      new Map([
        [
          "a-law",
          justification(JUSTIFICATION_ID, {
            version: 1,
            blocks: [
              {
                kind: "docx-folio",
                fileFieldId: toSafeId<"field">(FILE_FIELD_ID),
                statements: [
                  {
                    text: "stmt",
                    citations: [
                      { citationStatus: "unverified", text: "Model guess." },
                      {
                        citationStatus: "verified",
                        blockId: "b7",
                        text: "Clause 9 quoted.",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        ],
      ]),
    );
    const finding = data.findings[0];
    expect(finding?.citations).toEqual([
      { kind: "docx", blockId: "", text: "Model guess.", grounded: false },
      { kind: "docx", blockId: "b7", text: "Clause 9 quoted.", grounded: true },
    ]);
    // The risk projection skips the ungrounded hint (mirrors the old skip).
    expect(data.contracts[0]?.risks[0]?.citation).toBe("Clause 9 quoted.");
  });

  test("preserves the pdf bates/page locator with the statement text", () => {
    const entities = [
      makeEntity(ENTITY_A, "Scan", [
        field("a-law", ASK_LAW, text("NY law")),
        field("a-vlaw", VERDICT_LAW, select("deviation")),
      ]),
    ];
    const { data } = assemble(
      entities,
      new Map([
        [
          "a-law",
          justification(JUSTIFICATION_ID, {
            version: 1,
            blocks: [
              {
                kind: "pdf-bates",
                fileFieldId: toSafeId<"field">(FILE_FIELD_ID),
                statements: [
                  {
                    text: "Governed by the laws of New York.",
                    citations: [{ bates: "ATLAS-000123", pageNumber: 4 }],
                  },
                ],
              },
            ],
          }),
        ],
      ]),
    );
    expect(data.findings[0]?.citations).toEqual([
      {
        kind: "pdf",
        pageNumber: 4,
        bates: "ATLAS-000123",
        text: "Governed by the laws of New York.",
      },
    ]);
    expect(data.contracts[0]?.risks[0]?.citation).toBe(
      "Governed by the laws of New York.",
    );
  });

  test("rolls up reviewer state: lock from cell metadata, decision from the ledger", () => {
    const entities = [
      makeEntity(
        ENTITY_A,
        "NDA",
        [
          field("a-vlaw", VERDICT_LAW, select("deviation")),
          field("a-vterm", VERDICT_TERM, select("compliant")),
        ],
        [lockedCell(VERDICT_LAW)],
      ),
      makeEntity(ENTITY_B, "MSA", [
        field("b-vlaw", VERDICT_LAW, select("deviation")),
        field("b-vterm", VERDICT_TERM, select("missing")),
      ]),
    ];
    const { data } = assemble(
      entities,
      new Map(),
      new Map([
        [reviewDecisionKey(ENTITY_A, SOURCE_LAW), "accepted"],
        [reviewDecisionKey(ENTITY_B, SOURCE_LAW), "open"],
        [reviewDecisionKey(ENTITY_B, SOURCE_TERM), "dismissed"],
      ]),
    );
    // Four verdict cells (2 contracts × 2 graded columns); one is locked.
    expect(data.review).toEqual({
      openFindings: 1,
      acceptedFindings: 1,
      dismissedFindings: 1,
      lockedCells: 1,
      unlockedVerdictCells: 3,
    });
    const nda = data.findings.find((f) => f.contractIndex === 1);
    expect(nda?.review).toEqual({ locked: true, decision: "accepted" });
    // A finding without a ledger row reads as "none" (counted nowhere).
    const { data: undecided } = assemble(entities, new Map());
    expect(undecided.findings.every((f) => f.review.decision === "none")).toBe(
      true,
    );
    expect(undecided.review.openFindings).toBe(0);
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

  test("sweeps abandoned rows, leaves live ones alone", () => {
    // Old running row → orphaned by a dead worker; recover it.
    expect(
      isStuckReportExport(
        { status: "running", updatedAt: minutesAgo(45) },
        now,
      ),
    ).toBe(true);
    // Queued past the short threshold → possibly just backlogged; the job
    // persists in the queue and the sweep runs before the worker starts, so
    // it MUST be left for the worker.
    expect(
      isStuckReportExport({ status: "queued", updatedAt: minutesAgo(31) }, now),
    ).toBe(false);
    // Queued for a day → the job is gone (queue data loss); recover it.
    expect(
      isStuckReportExport(
        { status: "queued", updatedAt: minutesAgo(25 * 60) },
        now,
      ),
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
