import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { parseDocx } from "@stll/folio-core/server";

import type {
  AssembledReport,
  ReportContract,
  ReportData,
} from "@/api/handlers/reports/build-report-data";
import { reportCitationKey } from "@/api/handlers/reports/build-report-data";
import type { ReportFinding } from "@/api/handlers/reports/report-findings";
import {
  EMPTY_NEGOTIATION,
  NO_MATCHED_REF,
} from "@/api/handlers/reports/report-findings";
import type { AiFieldGenerator } from "@/api/lib/docx/resolve-ai-fields";

import { renderReportSpec } from "./render-report-spec";
import type { ReportSection, ReportSpec } from "./report-spec";
import { parseReportSpec, REPORT_SECTION_KINDS } from "./report-spec";

// ── Fixture: the shape `assembleReportData` produces, hand-built ─────────────

const ENTITY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTITY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FILE_FIELD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JUSTIFICATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const VIEW_ID = "22222222-2222-4222-8222-222222222222";

const finding = (
  overrides: Partial<ReportFinding> &
    Pick<
      ReportFinding,
      "contractIndex" | "findingIndex" | "severity" | "issue"
    >,
): ReportFinding => ({
  contractName: "",
  documentType: "",
  verdict: "deviation",
  rationale: "",
  matchedRef: NO_MATCHED_REF,
  guidance: "",
  idealText: "",
  negotiation: EMPTY_NEGOTIATION,
  hasNegotiation: false,
  citations: [],
  review: { locked: false, decision: "none" },
  ...overrides,
});

const termMissing = finding({
  contractIndex: 2,
  findingIndex: 1,
  contractName: "MSA",
  documentType: "MSA",
  issue: "Term",
  severity: "blocker",
  verdict: "missing",
  rationale: "No term clause found.",
  idealText: "Fixed term of 24 months.",
});

const lawDeviationNda = finding({
  contractIndex: 1,
  findingIndex: 1,
  contractName: "NDA",
  documentType: "NDA",
  issue: "Governing law",
  severity: "high",
  rationale: "New York law.",
  matchedRef: { kind: "redLine", label: "", text: "Non-EU law." },
  guidance: "Prefer Czech law.",
  negotiation: {
    rationale: "Forum risk.",
    talkingPoints: ["Offer EU-member law."],
    escalation: "",
  },
  hasNegotiation: true,
  citations: [
    { kind: "docx", blockId: "", text: "Model guess.", grounded: false },
    { kind: "docx", blockId: "b7", text: "Clause 9 quoted.", grounded: true },
  ],
});

const lawDeviationMsa = finding({
  contractIndex: 2,
  findingIndex: 2,
  contractName: "MSA",
  documentType: "MSA",
  issue: "Governing law",
  severity: "high",
  rationale: "New York law.",
  citations: [
    {
      kind: "pdf",
      pageNumber: 4,
      bates: "ATLAS-000123",
      text: "Governed by the laws of New York.",
    },
  ],
});

const contract = (
  index: number,
  name: string,
  documentType: string,
  findings: ReportFinding[],
): ReportContract => ({
  index,
  name,
  documentType,
  hasDocumentType: documentType.length > 0,
  riskLevel: findings.at(0)?.severity ?? "ok",
  hasRiskLevel: true,
  fields: [
    {
      label: "Governing law",
      value: "NY law",
      verdict: "deviation",
      severity: "high",
    },
    { label: "Term", value: "", verdict: "missing", severity: "blocker" },
  ],
  risks: findings.map((f) => ({
    severity: f.severity,
    issue: f.issue,
    verdict: f.verdict,
    rationale: f.rationale,
    citation: "",
    hasCitation: false,
  })),
  hasRisks: findings.length > 0,
});

const nda = contract(1, "NDA", "NDA", [lawDeviationNda]);
const msa = contract(2, "MSA", "MSA", [termMissing, lawDeviationMsa]);
const lease = contract(3, "Lease", "", []);

const stats = (
  findings: ReportFinding[],
  total: number,
): ReportData["stats"] => ({
  total,
  redFlags: findings.length,
  bySeverity: {
    blocker: findings.filter((f) => f.severity === "blocker").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
  },
});

const findings = [termMissing, lawDeviationNda, lawDeviationMsa];

const LONG_NOTE = "x".repeat(200);

const gridRow = (c: ReportContract) => ({
  name: c.name,
  cells: [
    ...c.fields.map((f) => ({
      label: f.label,
      value: f.value,
      verdict: f.verdict,
      severity: f.severity,
    })),
    // A plain ASK column: no verdict, long free text.
    { label: "Notes", value: LONG_NOTE, verdict: "", severity: "" },
    // A graded column whose verdict is not set yet: the clause text is
    // extracted, the severity comes from the column, the tier is blank.
    {
      label: "Liability cap",
      value: "Capped at fees paid.",
      verdict: "",
      severity: "medium",
    },
  ],
  summary: "",
});

const report = (): AssembledReport => ({
  data: {
    workspace: { name: "Acme DD" },
    generatedAt: "2 July 2026",
    stats: stats(findings, 3),
    contracts: [nda, msa, lease],
    findings,
    groups: [
      {
        documentType: "MSA",
        contracts: [msa],
        findings: [termMissing, lawDeviationMsa],
        stats: stats([termMissing, lawDeviationMsa], 1),
      },
      {
        documentType: "",
        contracts: [lease],
        findings: [],
        stats: stats([], 1),
      },
      {
        documentType: "NDA",
        contracts: [nda],
        findings: [lawDeviationNda],
        stats: stats([lawDeviationNda], 1),
      },
    ],
    review: {
      openFindings: 0,
      acceptedFindings: 0,
      dismissedFindings: 0,
      lockedCells: 0,
      unlockedVerdictCells: 6,
    },
    grid: {
      columns: [
        { label: "Governing law", kind: "graded" },
        { label: "Term", kind: "graded" },
        { label: "Notes", kind: "field" },
        { label: "Liability cap", kind: "graded" },
      ],
      rows: [nda, msa, lease].map(gridRow),
    },
    hasVerdicts: true,
    aiNarrative: true,
  },
  links: {
    citations: new Map([
      [
        reportCitationKey({
          contractIndex: 1,
          findingIndex: 1,
          citationIndex: 2,
        }),
        {
          entityId: ENTITY_A,
          fileFieldId: FILE_FIELD_ID,
          justificationId: JUSTIFICATION_ID,
        },
      ],
      [
        reportCitationKey({
          contractIndex: 2,
          findingIndex: 2,
          citationIndex: 1,
        }),
        {
          entityId: ENTITY_B,
          fileFieldId: FILE_FIELD_ID,
          justificationId: JUSTIFICATION_ID,
        },
      ],
    ]),
  },
});

const linkBase = {
  appUrl: "https://app.example.test",
  workspaceId: WORKSPACE_ID,
  viewId: VIEW_ID,
};

const spec = (sections: unknown[]): ReportSpec => {
  const parsed = parseReportSpec({ version: 1, name: "Test", sections });
  if (Result.isError(parsed)) {
    throw parsed.error;
  }
  return parsed.value;
};

type RenderOverrides = {
  aiNarrative?: boolean;
  generateAiValue?: AiFieldGenerator;
  prompts?: Map<string, string>;
  withLinks?: boolean;
};

const render = async (sections: unknown[], overrides: RenderOverrides = {}) => {
  const rendered = await renderReportSpec({
    spec: spec(sections),
    report: report(),
    prompts: overrides.prompts ?? new Map(),
    generateAiValue: overrides.generateAiValue,
    aiNarrative: overrides.aiNarrative ?? false,
    linkBase: overrides.withLinks === false ? undefined : linkBase,
  });
  if (Result.isError(rendered)) {
    throw rendered.error;
  }
  return await parseDocx(rendered.value, { preloadFonts: false });
};

type Parsed = Awaited<ReturnType<typeof render>>;
type Block = Parsed["package"]["document"]["content"][number];

const paragraphText = (block: Block): string =>
  block.type === "paragraph"
    ? block.content
        .flatMap((item) =>
          item.type === "run"
            ? item.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
            : [],
        )
        .join("")
    : "";

const headings = (parsed: Parsed): [string, string][] =>
  parsed.package.document.content.flatMap((block) =>
    block.type === "paragraph" &&
    block.formatting?.styleId?.startsWith("Heading")
      ? [[block.formatting.styleId, paragraphText(block)] as [string, string]]
      : [],
  );

type ParsedCell = NonNullable<
  ReturnType<typeof tables>[number]["rows"][number]["cells"][number]
>;

const cellText = (cell: ParsedCell | undefined): string | undefined =>
  cell?.content.map(paragraphText).join("");

const cellFontSize = (cell: ParsedCell | undefined): number | undefined =>
  cell?.content
    .flatMap((block) =>
      block.type === "paragraph"
        ? block.content.flatMap((item) =>
            item.type === "run" && item.formatting?.fontSize !== undefined
              ? [item.formatting.fontSize]
              : [],
          )
        : [],
    )
    .at(0);

const tables = (parsed: Parsed) =>
  parsed.package.document.content.flatMap((block) =>
    block.type === "table" ? [block] : [],
  );

const endnoteHrefs = (parsed: Parsed): string[] =>
  (parsed.package.endnotes ?? []).flatMap((note) =>
    note.content.flatMap((block) =>
      block.type === "paragraph"
        ? block.content.flatMap((item) =>
            item.type === "hyperlink" && item.href ? [item.href] : [],
          )
        : [],
    ),
  );

// ── Tests ────────────────────────────────────────────────────────────────────

describe("renderReportSpec", () => {
  test("every section kind renders without throwing (schema ↔ renderer parity)", async () => {
    // Total by construction: a new kind in the schema fails to compile here.
    const oneOfEach = {
      cover: {
        kind: "cover",
        title: "{{workspace.name}}",
        subtitle: "{{generatedAt}}",
        notice: "Confidential",
      },
      toc: { kind: "toc" },
      "page-break": { kind: "page-break" },
      narrative: {
        kind: "narrative",
        heading: "Summary",
        prompt: { text: "Write." },
      },
      stats: { kind: "stats", by: "documentType" },
      "findings-table": {
        kind: "findings-table",
        columns: [
          "severity",
          "contract",
          "documentType",
          "issue",
          "verdict",
          "rationale",
          "recommendation",
        ],
      },
      grouped: {
        kind: "grouped",
        by: "documentType",
        order: "name",
        heading: "{{group.documentType}}",
        children: [
          { kind: "stats", by: "severity" },
          {
            kind: "findings",
            include: [
              "rationale",
              "matchedRef",
              "idealText",
              "guidance",
              "negotiation",
            ],
            citations: "inline",
          },
          { kind: "per-contract" },
        ],
      },
      findings: {
        kind: "findings",
        include: ["rationale"],
        citations: "endnote",
      },
      "per-contract": { kind: "per-contract", heading: "Contracts" },
      matrix: { kind: "matrix" },
      appendix: {
        kind: "appendix",
        heading: "Annex",
        children: [{ kind: "matrix", heading: "Matrix" }],
      },
    } as const satisfies Record<
      ReportSection["kind"],
      { kind: ReportSection["kind"]; [key: string]: unknown }
    >;
    expect(Object.keys(oneOfEach).sort()).toEqual(
      [...REPORT_SECTION_KINDS].sort(),
    );

    const parsed = await render(Object.values(oneOfEach), {
      aiNarrative: true,
      generateAiValue: async () => ({ type: "drafted", value: "Drafted." }),
    });
    expect(parsed.package.document.content.length).toBeGreaterThan(0);
  });

  test("headings in order, TOC field, header and footer fields", async () => {
    const parsed = await render([
      { kind: "toc", levels: { from: 1, to: 2 } },
      { kind: "stats", heading: "By severity", by: "severity" },
      { kind: "per-contract", heading: "Contract review" },
      {
        kind: "appendix",
        heading: "Review matrix",
        children: [{ kind: "matrix" }],
      },
    ]);

    expect(headings(parsed)).toEqual([
      ["Heading1", "By severity"],
      ["Heading1", "Contract review"],
      ["Heading2", "1. NDA"],
      ["Heading3", "Risks"],
      ["Heading2", "2. MSA"],
      ["Heading3", "Risks"],
      ["Heading2", "3. Lease"],
      ["Heading1", "Review matrix"],
    ]);

    const toc = parsed.package.document.content
      .flatMap((block) => (block.type === "paragraph" ? block.content : []))
      .find((item) => item.type === "complexField" && item.fieldType === "TOC");
    expect(toc?.type === "complexField" && toc.instruction).toBe(
      'TOC \\o "1-2" \\h \\z \\u',
    );
    expect(parsed.package.settings?.updateFields).toBe(true);

    const header = [...(parsed.package.headers?.values() ?? [])].at(0);
    expect(header?.content.map(paragraphText)).toEqual(["Acme DD"]);
    const footer = [...(parsed.package.footers?.values() ?? [])].at(0);
    const footerFields = (footer?.content ?? []).flatMap((block) =>
      block.type === "paragraph"
        ? block.content.flatMap((item) =>
            item.type === "complexField" ? [item.fieldType] : [],
          )
        : [],
    );
    expect(footerFields).toEqual(["PAGE", "NUMPAGES"]);
  });

  test("findings-table row count matches the severity filter and limit", async () => {
    const all = await render([
      { kind: "findings-table", columns: ["severity", "issue"] },
    ]);
    expect(tables(all).at(0)?.rows).toHaveLength(findings.length + 1);

    const high = await render([
      {
        kind: "findings-table",
        columns: ["severity", "issue"],
        severity: ["high"],
      },
    ]);
    const expected = findings.filter((f) => f.severity === "high");
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).not.toBe(findings.length);
    const highTable = tables(high).at(0);
    expect(highTable?.rows).toHaveLength(expected.length + 1);
    // Severity cell is shaded from the total severity map.
    expect(
      highTable?.rows.at(1)?.cells.at(0)?.formatting?.shading?.fill?.rgb,
    ).toBe("FCE5CD");

    const limited = await render([
      { kind: "findings-table", columns: ["issue"], limit: 1 },
    ]);
    expect(tables(limited).at(0)?.rows).toHaveLength(2);
  });

  test("matrix is the real docs × columns grid with a repeated header", async () => {
    const parsed = await render([{ kind: "matrix" }]);
    const { grid } = report().data;
    const matrix = tables(parsed).at(0);
    expect(matrix?.rows).toHaveLength(grid.rows.length + 1);
    for (const row of matrix?.rows ?? []) {
      expect(row.cells).toHaveLength(grid.columns.length + 1);
    }
    expect(matrix?.rows.at(0)?.formatting?.header).toBe(true);
    expect(matrix?.formatting?.layout).toBe("fixed");
    expect(matrix?.columnWidths).toHaveLength(grid.columns.length + 1);
    expect(matrix?.columnWidths?.at(0)).toBe(2400);

    // A graded cell carries only the tier label, shaded from the tier map; a
    // plain cell carries the value truncated to 60 chars, unshaded, at 8pt.
    const ndaRow = matrix?.rows.at(1);
    const graded = ndaRow?.cells.at(1);
    expect(cellText(graded)).toBe("Deviation");
    expect(graded?.formatting?.shading?.fill?.rgb).toBe("F4CCCC");
    expect(cellText(ndaRow?.cells.at(2))).toBe("Missing");
    const plain = ndaRow?.cells.at(3);
    expect(LONG_NOTE.length).toBeGreaterThan(60);
    expect(cellText(plain)).toHaveLength(60);
    expect(cellText(plain)?.endsWith("…")).toBe(true);
    expect(plain?.formatting?.shading).toBeUndefined();
    expect(cellFontSize(plain)).toBe(16);

    // A graded cell with no verdict yet stays blank: neither the extracted
    // clause text nor a shading is a grade.
    const unset = grid.rows.at(0)?.cells.at(3);
    expect(unset?.value.length).toBeGreaterThan(0);
    expect(unset?.verdict).toBe("");
    const pending = ndaRow?.cells.at(4);
    expect(cellText(pending)).toBe("");
    expect(pending?.formatting?.shading).toBeUndefined();
  });

  test("matrix columns: graded drops the plain columns, keeps the contract name and unset graded columns", async () => {
    const parsed = await render([{ kind: "matrix", columns: "graded" }]);
    const { grid } = report().data;
    const gradedColumns = grid.columns.filter(
      (column) => column.kind === "graded",
    );
    expect(gradedColumns.length).toBeGreaterThan(0);
    expect(gradedColumns.length).not.toBe(grid.columns.length);
    // The unset graded column has no verdict in any row yet is still graded.
    const unsetIndex = grid.columns.findIndex(
      (column) => column.label === "Liability cap",
    );
    expect(
      grid.rows.every((row) => row.cells.at(unsetIndex)?.verdict === ""),
    ).toBe(true);
    expect(gradedColumns.map((column) => column.label)).toContain(
      "Liability cap",
    );
    const matrix = tables(parsed).at(0);
    expect(matrix?.rows.at(0)?.cells.map(cellText)).toEqual([
      "Contract",
      ...gradedColumns.map((column) => column.label),
    ]);
    for (const row of matrix?.rows ?? []) {
      expect(row.cells).toHaveLength(gradedColumns.length + 1);
    }
  });

  test("stats and findings tables use fixed layouts with explicit widths", async () => {
    const parsed = await render([
      { kind: "stats", by: "documentType" },
      {
        kind: "findings-table",
        columns: ["severity", "contract", "issue", "verdict", "rationale"],
      },
    ]);
    const [statsTable, findingsTable] = tables(parsed);
    expect(statsTable?.formatting?.layout).toBe("fixed");
    expect(statsTable?.columnWidths?.slice(1)).toEqual([
      900, 900, 900, 900, 900, 900,
    ]);
    expect(findingsTable?.formatting?.layout).toBe("fixed");
    expect(findingsTable?.columnWidths).toEqual([
      1100,
      2000,
      1800,
      1100,
      9360 - 1100 - 2000 - 1800 - 1100,
    ]);
  });

  test("cover owns its page and endnotes number decimally", async () => {
    const parsed = await render([
      { kind: "cover", title: "{{workspace.name}}", subtitle: "Review" },
      { kind: "findings", include: [], citations: "endnote" },
    ]);
    const content = parsed.package.document.content;
    const styles = content
      .slice(0, 3)
      .map((block) =>
        block.type === "paragraph" ? block.formatting?.styleId : block.type,
      );
    expect(styles).toEqual(["Title", "Subtitle", undefined]);
    const breakAfterCover = content.at(2);
    expect(
      breakAfterCover?.type === "paragraph" &&
        breakAfterCover.content.some(
          (item) =>
            item.type === "run" &&
            item.content.some(
              (c) => c.type === "break" && c.breakType === "page",
            ),
        ),
    ).toBe(true);
    expect(parsed.package.endnotes?.length).toBeGreaterThan(0);
    expect(
      parsed.package.document.finalSectionProperties?.endnotePr?.numFmt,
    ).toBe("decimal");
  });

  test("endnote citations: one per grounded citation, linking into stella", async () => {
    const parsed = await render([
      { kind: "findings", include: ["rationale"], citations: "endnote" },
    ]);
    // Ungrounded docx hints are never rendered: 2 of the 3 fixture citations.
    const grounded = findings
      .flatMap((f) => f.citations)
      .filter((c) => c.kind === "pdf" || c.grounded);
    expect(grounded).toHaveLength(2);
    expect(findings.flatMap((f) => f.citations)).toHaveLength(3);
    expect(parsed.package.endnotes).toHaveLength(grounded.length);

    const hrefs = endnoteHrefs(parsed).map((href) => new URL(href));
    expect(hrefs).toHaveLength(2);
    const [docxLink, pdfLink] = hrefs;
    expect(docxLink?.pathname).toBe(
      `/workspaces/${WORKSPACE_ID}/${VIEW_ID}/document`,
    );
    expect(Object.fromEntries(docxLink?.searchParams ?? [])).toEqual({
      entity: ENTITY_A,
      field: FILE_FIELD_ID,
      justification: JUSTIFICATION_ID,
      block: "b7",
    });
    // `justificationPage` activates the highlight, `pdfPage` scrolls there.
    expect(Object.fromEntries(pdfLink?.searchParams ?? [])).toEqual({
      entity: ENTITY_B,
      field: FILE_FIELD_ID,
      justification: JUSTIFICATION_ID,
      justificationPage: "4",
      pdfPage: "4",
    });

    // Without a link base the note keeps the quote and drops the hyperlink.
    const unlinked = await render(
      [{ kind: "findings", include: [], citations: "endnote" }],
      { withLinks: false },
    );
    expect(unlinked.package.endnotes).toHaveLength(2);
    expect(endnoteHrefs(unlinked)).toEqual([]);
  });

  test("per-contract inside grouped nests contracts below the group heading", async () => {
    const parsed = await render([
      {
        kind: "grouped",
        by: "documentType",
        order: "name",
        heading: "{{group.documentType}}",
        level: 2,
        children: [{ kind: "per-contract" }],
      },
    ]);
    expect(headings(parsed)).toEqual([
      ["Heading2", "MSA"],
      ["Heading3", "2. MSA"],
      ["Heading3", "Risks"],
      ["Heading2", "NDA"],
      ["Heading3", "1. NDA"],
      ["Heading3", "Risks"],
      ["Heading2", "Unclassified"],
      ["Heading3", "3. Lease"],
    ]);

    const withHeading = await render([
      {
        kind: "grouped",
        by: "documentType",
        order: "name",
        heading: "{{group.documentType}}",
        children: [{ kind: "per-contract", heading: "Contracts" }],
      },
    ]);
    expect(headings(withHeading).slice(0, 4)).toEqual([
      ["Heading1", "MSA"],
      ["Heading2", "Contracts"],
      ["Heading3", "2. MSA"],
      ["Heading3", "Risks"],
    ]);
  });

  test("narrative off: no heading, no generator call", async () => {
    const calls: string[] = [];
    const generator: AiFieldGenerator = async ({ prompt }) => {
      calls.push(prompt);
      return { type: "drafted", value: "Should not appear." };
    };
    const parsed = await render(
      [
        {
          kind: "narrative",
          heading: "Executive summary",
          prompt: { text: "Summarize." },
        },
        { kind: "stats", heading: "Stats", by: "severity" },
      ],
      { aiNarrative: false, generateAiValue: generator },
    );
    expect(calls).toEqual([]);
    expect(headings(parsed)).toEqual([["Heading1", "Stats"]]);
    expect(parsed.package.document.content.map(paragraphText)).not.toContain(
      "Should not appear.",
    );
  });

  test("narrative on: prompt ref resolves, generator text is injected, scope is the group", async () => {
    const calls: { prompt: string; values: Record<string, unknown> }[] = [];
    const generator: AiFieldGenerator = async ({ prompt, values }) => {
      calls.push({ prompt, values });
      return {
        type: "drafted",
        value: `Drafted: ${prompt}\n\nSecond paragraph.`,
      };
    };
    const parsed = await render(
      [
        {
          kind: "narrative",
          heading: "Executive summary",
          level: 1,
          prompt: { ref: "exec" },
        },
        {
          kind: "grouped",
          by: "documentType",
          order: "redFlagsDesc",
          heading: "{{group.documentType}}",
          children: [
            {
              kind: "narrative",
              heading: "Group summary",
              prompt: { text: "Group." },
            },
          ],
        },
      ],
      {
        aiNarrative: true,
        generateAiValue: generator,
        prompts: new Map([["exec", "Exec."]]),
      },
    );
    expect(calls.map((c) => c.prompt)).toEqual([
      "Exec.",
      "Group.",
      "Group.",
      "Group.",
    ]);
    // Root scope: the data object without `links`; group scope: the group.
    expect(calls.at(0)?.values).not.toHaveProperty("links");
    expect(calls.at(0)?.values).toHaveProperty("contracts");
    expect(calls.at(1)?.values).toHaveProperty("documentType", "MSA");

    const texts = parsed.package.document.content.map(paragraphText);
    expect(texts).toContain("Drafted: Exec.");
    expect(texts).toContain("Second paragraph.");
    expect(headings(parsed)).toEqual([
      ["Heading1", "Executive summary"],
      ["Heading1", "MSA"],
      ["Heading2", "Group summary"],
      ["Heading1", "Unclassified"],
      ["Heading2", "Group summary"],
      ["Heading1", "NDA"],
      ["Heading2", "Group summary"],
    ]);
  });

  test("a failed requested narrative fails the report instead of omitting its section", async () => {
    for (const reason of [
      "empty",
      "generation-failed",
      "interrupted",
      "truncated",
    ] as const) {
      const rendered = await renderReportSpec({
        spec: spec([{ kind: "narrative", prompt: { text: "Summarize." } }]),
        report: report(),
        prompts: new Map(),
        aiNarrative: true,
        generateAiValue: async () => ({
          type: "failed",
          reason,
          message: "Draft unavailable",
        }),
      });
      expect(Result.isError(rendered)).toBe(true);
      if (Result.isError(rendered)) {
        expect(rendered.error.message).toContain(`narrative.1: ${reason}`);
      }
    }
  });

  test("findings parts and inline citations", async () => {
    const parsed = await render([
      {
        kind: "findings",
        include: [
          "rationale",
          "matchedRef",
          "idealText",
          "guidance",
          "negotiation",
        ],
        citations: "inline",
        suppressVerdicts: ["missing"],
      },
    ]);
    const texts = parsed.package.document.content.map(paragraphText);
    expect(texts).toContain("Governing law  ·  High  ·  deviation");
    expect(texts).not.toContain("Term  ·  Blocker  ·  missing");
    expect(texts).toContain("Why: New York law.");
    expect(texts).toContain("Matched: Non-EU law.");
    expect(texts).toContain("Recommendation: Prefer Czech law.");
    expect(texts).toContain("Negotiation: Forum risk.");
    expect(texts).toContain("– Offer EU-member law.");
    expect(texts).toContain("Citation: “Clause 9 quoted.”");
    expect(texts).toContain(
      "Citation: “Governed by the laws of New York.” (ATLAS-000123, p. 4)",
    );
    expect(texts).not.toContain("Citation: “Model guess.”");
  });
});
