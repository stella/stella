import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";

import { propertyConfig } from "@stll/property-testing";

import type { JustificationContent } from "@/api/db/schema";
import type { PropertyTool } from "@/api/db/schema-validators";
import type { QueryEntityResult } from "@/api/handlers/entities/query-entities";
import {
  buildCsvExport,
  buildExportColumns,
  buildExportTable,
  buildXlsxExport,
  formatExportDate,
  formatFieldContent,
  sanitizeSpreadsheetText,
  sanitizeWorksheetName,
  SPREADSHEET_EXPORT_LIMITS,
} from "@/api/handlers/views/table-export";
import { toSafeId } from "@/api/lib/branded-types";
import type { ViewLayout } from "@/api/lib/views-schema";

const manualTool: PropertyTool = { version: 1, type: "manual-input" };
const aiTool: PropertyTool = {
  version: 1,
  type: "ai-model",
  prompt: "Extract",
};

const exportLink = {
  baseUrl: "https://app.example.test",
  workspaceId: "ws-1",
  viewId: "view-1",
};

const exportOptions = (
  justificationByFieldId = new Map<string, JustificationContent>(),
) => ({ link: exportLink, justificationByFieldId });

const flagStyleIds = {
  "needs-review": 3,
  important: 4,
  "follow-up": 5,
  contradiction: 6,
  verified: 7,
} as const;

const flagFillColors = {
  "needs-review": "FFFEF3E2",
  important: "FFECF3FE",
  "follow-up": "FFF4EEFE",
  contradiction: "FFFDECEC",
  verified: "FFE3F8EF",
} as const;

const cellFlagIds = [
  "needs-review",
  "important",
  "follow-up",
  "contradiction",
  "verified",
] as const;

type TestCellStyle = "default" | (typeof cellFlagIds)[number];

const textCell = (
  value: string,
  style: TestCellStyle = "default",
): { type: "text"; value: string; style: TestCellStyle } => ({
  type: "text",
  value,
  style,
});

const hasInvalidXmlTextChar = (value: string): boolean => {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint !== undefined &&
      codePoint < 0x20 &&
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d
    ) {
      return true;
    }
  }
  return false;
};

const sanitizeSpreadsheetCellForTest = (value: string): string =>
  sanitizeSpreadsheetText(value, SPREADSHEET_EXPORT_LIMITS.cellTextChars);

const tableLayout = (
  partial: Partial<Extract<ViewLayout, { type: "table" }>> = {},
): Extract<ViewLayout, { type: "table" }> => ({
  version: 1,
  type: "table",
  filters: [],
  sorts: [],
  hiddenProperties: [],
  columnOrder: [],
  columnPinning: [],
  ...partial,
});

const entity = (
  fields: QueryEntityResult["fields"],
  partial: Partial<QueryEntityResult> = {},
): QueryEntityResult => ({
  entityId: "entity-1",
  kind: "document",
  name: "Document",
  parentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "Alice",
  createdByImage: null,
  createdByDeletedAt: null,
  version: 3,
  updatedAt: "2026-01-02T00:00:00.000Z",
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
  cellMetadata: [],
  fields,
  ...partial,
});

describe("table export", () => {
  test("applies table order after hidden columns", () => {
    const columns = buildExportColumns(
      tableLayout({
        hiddenProperties: ["p3", "_updated-at"],
        columnOrder: ["_version", "p2", "missing", "p1"],
      }),
      [
        { id: "p1", name: "A", tool: manualTool },
        { id: "p2", name: "B", tool: manualTool },
        { id: "p3", name: "C", tool: manualTool },
      ],
    );

    expect(columns.map((column) => column.header)).toEqual([
      "Version",
      "B",
      "A",
      "Author",
    ]);
  });

  test("formats field content for export", () => {
    expect(
      formatFieldContent(
        {
          version: 1,
          type: "multi-select",
          value: ["Urgent", "Client"],
        },
        "en",
      ),
    ).toBe("Urgent, Client");
    expect(
      formatFieldContent(
        {
          version: 1,
          type: "int",
          value: 1200,
          currency: "EUR",
        },
        "en",
      ),
    ).toBe("€1,200");
    expect(
      formatFieldContent(
        {
          version: 1,
          type: "date",
          value: "2026-01-02T00:00:00.000Z",
        },
        "en",
      ),
    ).toBe("Jan 2, 2026");
    expect(formatFieldContent({ version: 1, type: "pending" }, "en")).toBe("");
  });

  test("formats metadata dates for human export", () => {
    expect(formatExportDate("2026-01-02T00:00:00.000Z", "en")).toBe(
      "Jan 2, 2026",
    );
    expect(formatExportDate("2026-01-02T00:00:00.000Z", "cs")).toBe(
      "2. 1. 2026",
    );
  });

  test("csv escapes delimiters and neutralizes spreadsheet formulas", () => {
    const columns = buildExportColumns(tableLayout(), [
      { id: "p1", name: "Matter, name", tool: manualTool },
    ]);
    const table = buildExportTable(
      columns,
      [
        entity([
          {
            id: "field-1",
            entityId: "entity-1",
            propertyId: "p1",
            content: {
              version: 1,
              type: "text",
              value: '=HYPERLINK("https://example.com")',
            },
          },
        ]),
      ],
      "en",
      exportOptions(),
    );

    expect(buildCsvExport(table)).toBe(
      '"Matter, name",Author,Last updated,Version\n"\t=HYPERLINK(""https://example.com"")",Alice,"Jan 2, 2026",3',
    );
  });

  test("csv neutralizes line-feed prefixed formulas", () => {
    expect(
      buildCsvExport({
        columns: [
          {
            type: "property",
            id: "p1",
            propertyId: "p1",
            header: "Value",
          },
        ],
        rows: [[textCell("\n=cmd|' /C calc'!A0")]],
      }),
    ).toBe("Value\n\"\t\n=cmd|' /C calc'!A0\"");
  });

  test("xlsx stores cells as escaped inline strings", async () => {
    const bytes = await buildXlsxExport({
      columns: [
        {
          type: "property",
          id: "p1",
          propertyId: "p1",
          header: "Name",
        },
      ],
      rows: [[textCell('=1+1 & "quoted" <tag>')]],
    });
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("text");

    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("=1+1 &amp; &quot;quoted&quot; &lt;tag&gt;");
  });

  test("xlsx stores integer currency fields as numeric cells", async () => {
    const columns = buildExportColumns(tableLayout(), [
      { id: "p1", name: "Claim value", tool: manualTool },
    ]);
    const table = buildExportTable(
      columns,
      [
        entity([
          {
            id: "field-1",
            entityId: "entity-1",
            propertyId: "p1",
            content: {
              version: 1,
              type: "int",
              value: 875_000,
              currency: "EUR",
            },
          },
        ]),
      ],
      "en",
      exportOptions(),
    );

    const bytes = await buildXlsxExport(table);
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("text");
    const styles = await zip.file("xl/styles.xml")?.async("text");

    expect(sheet).toMatch(/<c r="A2" s="\d+"><v>875000<\/v><\/c>/u);
    expect(sheet).not.toContain('t="inlineStr"><is><t>€875,000</t>');
    expect(styles).toContain('formatCode="&quot;€&quot;#,##0"');
  });

  test("spreadsheet text sanitizer strips invalid XML and caps text", () => {
    const oversized = `ok\u0000bad${"x".repeat(
      SPREADSHEET_EXPORT_LIMITS.cellTextChars + 10,
    )}`;
    const sanitized = sanitizeSpreadsheetText(
      oversized,
      SPREADSHEET_EXPORT_LIMITS.cellTextChars,
    );

    expect(sanitized).not.toContain("\u0000");
    expect(Array.from(sanitized)).toHaveLength(
      SPREADSHEET_EXPORT_LIMITS.cellTextChars,
    );
    expect(sanitized.endsWith("\n[truncated]")).toBe(true);
  });

  test("worksheet names obey Excel's name limit and forbidden characters", () => {
    const name = sanitizeWorksheetName("[]:*?/\\");
    expect(name).toBe("Table");
    expect(
      sanitizeWorksheetName("Matter export with a very long legal matter name"),
    ).toHaveLength(SPREADSHEET_EXPORT_LIMITS.worksheetNameChars);
  });

  test("xlsx worksheet name comes from the matter name", async () => {
    const bytes = await buildXlsxExport({
      columns: [
        {
          type: "property",
          id: "p1",
          propertyId: "p1",
          header: "Name",
        },
      ],
      rows: [],
      worksheetName: "Atlas disclosure / privilege review",
    });
    const zip = await JSZip.loadAsync(bytes);
    const workbook = await zip.file("xl/workbook.xml")?.async("text");

    expect(workbook).toContain('name="Atlas disclosure   privilege re"');
  });

  test("xlsx styles headers, widths, freeze pane and flagged cells", async () => {
    const columns = buildExportColumns(tableLayout(), [
      { id: "p1", name: "Risk assessment", tool: manualTool },
    ]);
    const table = buildExportTable(
      columns,
      [
        entity(
          [
            {
              id: "field-1",
              entityId: "entity-1",
              propertyId: "p1",
              content: {
                version: 1,
                type: "text",
                value: "Needs privilege review before disclosure.",
              },
            },
          ],
          {
            cellMetadata: [
              {
                propertyId: "p1",
                metadata: {
                  version: 1,
                  manualFlags: ["needs-review"],
                },
              },
            ],
          },
        ),
      ],
      "en",
      exportOptions(),
    );

    const bytes = await buildXlsxExport(table);
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("text");
    const styles = await zip.file("xl/styles.xml")?.async("text");

    expect(sheet).toContain('<pane ySplit="1"');
    expect(sheet).toContain('<autoFilter ref="A1:D1"/>');
    expect(sheet).toContain(
      '<col min="1" max="1" width="42" customWidth="1"/>',
    );
    expect(sheet).toContain('<row r="1" ht="22" customHeight="1">');
    expect(sheet).toContain('<c r="A1" s="2" t="inlineStr">');
    expect(sheet).toContain('<c r="A2" s="3" t="inlineStr">');
    expect(styles).toContain('fgColor rgb="FFE5E7EB"');
    expect(styles).toContain(`fgColor rgb="${flagFillColors["needs-review"]}"`);
    expect(styles).toContain('wrapText="1"');
  });

  test("xlsx package contains no macro or external relationship parts", async () => {
    const bytes = await buildXlsxExport({
      columns: [
        {
          type: "property",
          id: "p1",
          propertyId: "p1",
          header: "Link",
        },
      ],
      rows: [
        [textCell('http://example.test =HYPERLINK("http://example.test")')],
      ],
    });
    const zip = await JSZip.loadAsync(bytes);
    const relFiles = Object.keys(zip.files).filter((path) =>
      path.endsWith(".rels"),
    );

    expect(Object.keys(zip.files)).not.toContain("xl/vbaProject.bin");
    expect(
      Object.keys(zip.files).some((path) => path.includes("externalLink")),
    ).toBe(false);
    for (const relFile of relFiles) {
      // oxlint-disable-next-line no-await-in-loop -- sequential test assertions over the archive's .rels entries
      const relXml = await zip.file(relFile)?.async("text");
      expect(relXml).not.toContain('TargetMode="External"');
      expect(relXml).not.toContain("hyperlink");
    }
  });

  test("xlsx uses the same flag color family as table metadata flags", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...cellFlagIds), async (flagId) => {
        const columns = buildExportColumns(tableLayout(), [
          { id: "p1", name: "AI status", tool: manualTool },
        ]);
        const table = buildExportTable(
          columns,
          [
            entity(
              [
                {
                  id: "field-1",
                  entityId: "entity-1",
                  propertyId: "p1",
                  content: {
                    version: 1,
                    type: "text",
                    value: "Flagged value",
                  },
                },
              ],
              {
                cellMetadata: [
                  {
                    propertyId: "p1",
                    metadata: {
                      version: 1,
                      manualFlags: [flagId],
                    },
                  },
                ],
              },
            ),
          ],
          "en",
          exportOptions(),
        );

        const bytes = await buildXlsxExport(table);
        const zip = await JSZip.loadAsync(bytes);
        const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("text");
        const styles = await zip.file("xl/styles.xml")?.async("text");

        expect(sheet).toContain(
          `<c r="A2" s="${flagStyleIds[flagId]}" t="inlineStr">`,
        );
        expect(styles).toContain(`fgColor rgb="${flagFillColors[flagId]}"`);
      }),
      propertyConfig({ numRuns: cellFlagIds.length }),
    );
  });

  test("xlsx property: arbitrary text remains inline string data", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 80 }), {
          minLength: 1,
          maxLength: 20,
        }),
        async (values) => {
          const bytes = await buildXlsxExport({
            columns: [
              {
                type: "property",
                id: "p1",
                propertyId: "p1",
                header: "Value",
              },
            ],
            rows: values.map((value) => [
              textCell(sanitizeSpreadsheetCellForTest(value)),
            ]),
          });
          const zip = await JSZip.loadAsync(bytes);
          const sheet = await zip
            .file("xl/worksheets/sheet1.xml")
            ?.async("text");
          const workbookRels = await zip
            .file("xl/_rels/workbook.xml.rels")
            ?.async("text");
          const rootRels = await zip.file("_rels/.rels")?.async("text");

          expect(sheet).not.toContain("<f>");
          expect(sheet).not.toContain("<hyperlink");
          expect(sheet === undefined || hasInvalidXmlTextChar(sheet)).toBe(
            false,
          );
          expect(workbookRels).not.toContain('TargetMode="External"');
          expect(rootRels).not.toContain('TargetMode="External"');
          expect(Object.keys(zip.files)).not.toContain("xl/vbaProject.bin");
          expect(sheet?.match(/t="inlineStr"/gu)?.length).toBe(
            values.length + 1,
          );
        },
      ),
      propertyConfig({ numRuns: 50 }),
    );
    // 50 zip builds + parses brush the default 5s timeout on loaded CI
    // runners; the explicit timeout keeps the property run deterministic.
  }, 20_000);

  test("xlsx property: long arbitrary values are capped before XML output", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 1, max: 200 })
          .map((extraChars) =>
            "x".repeat(SPREADSHEET_EXPORT_LIMITS.cellTextChars + extraChars),
          ),
        async (value) => {
          const bytes = await buildXlsxExport({
            columns: [
              {
                type: "property",
                id: "p1",
                propertyId: "p1",
                header: "Value",
              },
            ],
            rows: [[textCell(sanitizeSpreadsheetCellForTest(value))]],
          });
          const zip = await JSZip.loadAsync(bytes);
          const sheet = await zip
            .file("xl/worksheets/sheet1.xml")
            ?.async("text");

          expect(sheet).toContain("[truncated]");
          expect(sheet).not.toContain(value);
        },
      ),
      propertyConfig({ numRuns: 20 }),
    );
  }, 20_000);

  test("xlsx property: generated column widths stay readable and bounded", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.array(fc.array(fc.string({ maxLength: 120 }), { maxLength: 8 }), {
          maxLength: 12,
        }),
        async (headers, rowValues) => {
          const columns = headers.map((header, index) => ({
            type: "property" as const,
            id: `p${index}`,
            propertyId: `p${index}`,
            header,
          }));
          const rows = rowValues.map((row) =>
            headers.map((_, index) =>
              textCell(sanitizeSpreadsheetCellForTest(row.at(index) ?? "")),
            ),
          );
          const bytes = await buildXlsxExport({ columns, rows });
          const zip = await JSZip.loadAsync(bytes);
          const sheet = await zip
            .file("xl/worksheets/sheet1.xml")
            ?.async("text");
          const widthMatches = [
            ...(sheet?.matchAll(/ width="(?<width>\d+)"/gu) ?? []),
          ];

          expect(widthMatches).toHaveLength(headers.length);
          for (const match of widthMatches) {
            const width = Number(match.groups?.["width"]);
            expect(width).toBeGreaterThanOrEqual(12);
            expect(width).toBeLessThanOrEqual(42);
          }
        },
      ),
      propertyConfig({ numRuns: 50 }),
    );
    // 50 zip builds + parses can exceed Bun's default 5s timeout on loaded
    // CI runners; keep the invariant broad while making runtime deterministic.
  }, 20_000);

  test("merges a graded position into one column with its verdict tier and rationale", () => {
    const verdictTool: PropertyTool = {
      version: 1,
      type: "playbook-verdict",
      askPropertyId: "ask",
      rule: { kind: "positionMatch" },
      severity: "high",
      tiers: {
        fallbacks: [],
        acceptableRules: [],
        notAcceptableRules: [],
      },
    };
    const columns = buildExportColumns(tableLayout(), [
      { id: "ask", name: "Payment terms", tool: aiTool },
      { id: "verdict", name: "Payment terms verdict", tool: verdictTool },
    ]);

    // The standalone verdict property never gets its own column.
    expect(
      columns
        .filter((column) => column.type === "property")
        .map((c) => c.header),
    ).toEqual(["Payment terms"]);

    const justifications = new Map<string, JustificationContent>([
      [
        "verdict-field",
        {
          version: 1,
          blocks: [
            {
              kind: "playbook-verdict",
              rationale: "Net 30 exceeds the Net 15 standard.",
            },
          ],
        },
      ],
    ]);
    const table = buildExportTable(
      columns,
      [
        entity([
          {
            id: "ask-field",
            entityId: "entity-1",
            propertyId: "ask",
            content: { version: 1, type: "text", value: "Net 30" },
          },
          {
            id: "verdict-field",
            entityId: "entity-1",
            propertyId: "verdict",
            content: { version: 1, type: "single-select", value: "deviation" },
          },
        ]),
      ],
      "en",
      exportOptions(justifications),
    );

    expect(table.rows[0]?.[0]).toEqual({
      type: "text",
      value: "Net 30 (deviation)",
      style: "default",
      comment: "Net 30 exceeds the Net 15 standard.",
    });
  });

  test("links a document cell to its folio deep link and notes the extraction rationale", async () => {
    const columns = buildExportColumns(tableLayout(), [
      { id: "p1", name: "Contract", tool: aiTool },
    ]);
    const justifications = new Map<string, JustificationContent>([
      [
        "file-field",
        {
          version: 1,
          blocks: [
            {
              kind: "docx-folio",
              fileFieldId: toSafeId<"field">("file-field"),
              statements: [
                { text: "Liability is capped at fees paid.", citations: [] },
              ],
            },
          ],
        },
      ],
    ]);
    const table = buildExportTable(
      columns,
      [
        entity([
          {
            id: "file-field",
            entityId: "entity-1",
            propertyId: "p1",
            content: {
              version: 1,
              type: "file",
              id: "11111111-1111-1111-1111-111111111111",
              fileName: "contract.pdf",
              mimeType: "application/pdf",
              sizeBytes: 2048,
              encrypted: false,
              sha256Hex: "a".repeat(64),
              pdfFileId: null,
            },
          },
        ]),
      ],
      "en",
      exportOptions(justifications),
    );

    const bytes = await buildXlsxExport(table);
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("text");
    const sheetRels = await zip
      .file("xl/worksheets/_rels/sheet1.xml.rels")
      ?.async("text");
    const comments = await zip.file("xl/comments1.xml")?.async("text");

    expect(sheet).toContain('<hyperlink ref="A2" r:id="rId1"/>');
    expect(sheetRels).toContain('TargetMode="External"');
    expect(sheetRels).toContain(
      "https://app.example.test/workspaces/ws-1/view-1/document?entity=entity-1&amp;field=file-field",
    );
    expect(comments).toContain("Liability is capped at fees paid.");
  });
});
