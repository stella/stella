import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { discoverClauseSlots } from "@/api/handlers/docx/discover-clause-slots";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import {
  readManifest,
  writeManifest,
} from "@/api/handlers/docx/template-manifest";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import type {
  TemplateCheckClauseLink,
  TemplateCheckFinding,
} from "@/api/handlers/templates/check-template";
import {
  buildTemplateCheckFindings,
  MAX_CHECK_FINDINGS,
} from "@/api/handlers/templates/check-template";

// ── Helpers ──────────────────────────────────────────────

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org` +
  `/wordprocessingml/2006/main">` +
  `<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org',
      '/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="rels"',
      ' ContentType="application/vnd.openxmlformats',
      '-package.relationships+xml"/>',
      "</Types>",
    ].join(""),
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const emptyManifest: TemplateManifest = {
  version: 1,
  fields: [],
  conditions: [],
};

type CheckOptions = {
  paragraphs?: string[];
  manifest?: TemplateManifest | null;
  clauseLinks?: TemplateCheckClauseLink[];
};

/** Build a DOCX from paragraphs, run the real discovery machinery on it, and
 *  produce findings against the given manifest and clause links. */
const checkDocument = async ({
  paragraphs = [],
  manifest = emptyManifest,
  clauseLinks = [],
}: CheckOptions): Promise<TemplateCheckFinding[]> => {
  const buffer = await makeDocx(WRAP(paragraphs.map(P).join("")));
  const [discovered, clauseSlots] = await Promise.all([
    discoverTemplate(buffer),
    discoverClauseSlots(buffer),
  ]);
  return buildTemplateCheckFindings({
    discovered,
    manifest,
    clauseSlots,
    clauseLinks,
  });
};

const codesOf = (findings: TemplateCheckFinding[]): string[] =>
  findings.map((finding) => finding.code);

const field = (
  path: string,
): { path: string; label: string; inputType: "text" } => ({
  path,
  label: path,
  inputType: "text",
});

// ── Structure errors ─────────────────────────────────────

describe("template check: structure errors", () => {
  test("surfaces an unclosed #if as an error finding", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{#if isCorp}}", "Corp clause"],
      manifest: { ...emptyManifest, fields: [field("isCorp")] },
    });

    const structural = findings.filter((f) => f.code === "structureError");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.severity).toBe("error");
    expect(structural[0]?.directive).toContain("#if");
  });

  test("balanced blocks produce no structure findings", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{#if isCorp}}", "Corp clause", "{{/if}}"],
      manifest: { ...emptyManifest, fields: [field("isCorp")] },
    });

    expect(codesOf(findings)).not.toContain("structureError");
  });
});

// ── Markers vs. manifest fields ──────────────────────────

describe("template check: markers vs manifest", () => {
  test("flags a marker with no manifest field entry", async () => {
    const findings = await checkDocument({
      paragraphs: ["Name: {{clientName}}"],
    });

    expect(findings).toContainEqual({
      code: "markerWithoutField",
      severity: "warning",
      path: "clientName",
    });
  });

  test("a dotted marker is covered by a manifest entry for its root", async () => {
    const findings = await checkDocument({
      paragraphs: ["Seat: {{company.seat}}"],
      manifest: { ...emptyManifest, fields: [field("company")] },
    });

    expect(codesOf(findings)).not.toContain("markerWithoutField");
  });

  test("flags a manifest field whose marker appears nowhere as a warning", async () => {
    const findings = await checkDocument({
      paragraphs: ["No markers here"],
      manifest: { ...emptyManifest, fields: [field("ghost")] },
    });

    expect(findings).toContainEqual({
      code: "unplacedField",
      severity: "warning",
      path: "ghost",
    });
  });

  test("a field placed via a dotted marker is not unplaced", async () => {
    const findings = await checkDocument({
      paragraphs: ["Seat: {{company.seat}}"],
      manifest: { ...emptyManifest, fields: [field("company")] },
    });

    expect(codesOf(findings)).not.toContain("unplacedField");
  });
});

// ── Clause slots and links ───────────────────────────────

describe("template check: clause slots", () => {
  test("flags a clause slot with no linked clause", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{@clause:NonCompete}}"],
    });

    expect(findings).toContainEqual({
      code: "slotWithoutClause",
      severity: "error",
      slotName: "NonCompete",
    });
  });

  test("a link whose clause was deleted does not satisfy the slot", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{@clause:NonCompete}}"],
      clauseLinks: [{ slotName: "NonCompete", clause: null }],
    });

    expect(codesOf(findings)).toContain("slotWithoutClause");
  });

  test("a live link satisfies the slot", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{@clause:NonCompete}}"],
      clauseLinks: [{ slotName: "NonCompete", clause: { id: "clause_1" } }],
    });

    expect(codesOf(findings)).not.toContain("slotWithoutClause");
  });

  test("flags a link whose slot name matches no marker", async () => {
    const findings = await checkDocument({
      paragraphs: ["No slots here"],
      clauseLinks: [{ slotName: "Confidentiality", clause: { id: "c1" } }],
    });

    expect(findings).toContainEqual({
      code: "linkWithoutSlot",
      severity: "warning",
      slotName: "Confidentiality",
    });
  });

  test("links without a slot name are ignored", async () => {
    const findings = await checkDocument({
      paragraphs: ["No slots here"],
      clauseLinks: [{ slotName: null, clause: { id: "c1" } }],
    });

    expect(codesOf(findings)).not.toContain("linkWithoutSlot");
  });
});

// ── Field metadata quality ───────────────────────────────

describe("template check: field metadata", () => {
  test("flags missing label and missing input type", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{bare}}"],
      manifest: { ...emptyManifest, fields: [{ path: "bare" }] },
    });

    expect(findings).toContainEqual({
      code: "fieldMissingLabel",
      severity: "warning",
      path: "bare",
    });
    expect(findings).toContainEqual({
      code: "fieldMissingInputType",
      severity: "warning",
      path: "bare",
    });
  });

  test("a whitespace-only label counts as missing", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{bare}}"],
      manifest: {
        ...emptyManifest,
        fields: [{ path: "bare", label: "  ", inputType: "text" }],
      },
    });

    expect(codesOf(findings)).toContain("fieldMissingLabel");
  });

  test("formula fields render no input, so input type is not required", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{rent}} {{total}}"],
      manifest: {
        ...emptyManifest,
        fields: [
          field("rent"),
          { path: "total", label: "Total", formula: "rent * 2" },
        ],
      },
    });

    expect(codesOf(findings)).not.toContain("fieldMissingInputType");
  });

  test("flags a select field with neither options nor optionsFrom", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{currency}}"],
      manifest: {
        ...emptyManifest,
        fields: [{ path: "currency", label: "Currency", inputType: "select" }],
      },
    });

    expect(findings).toContainEqual({
      code: "selectWithoutOptions",
      severity: "error",
      path: "currency",
    });
  });

  test("a select with options or an optionsFrom source passes", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{currency}} {{payer}} {{parties}}"],
      manifest: {
        ...emptyManifest,
        fields: [
          {
            path: "currency",
            label: "Currency",
            inputType: "select",
            options: ["EUR", "CZK"],
          },
          {
            path: "payer",
            label: "Payer",
            inputType: "select",
            optionsFrom: "parties",
          },
          field("parties"),
        ],
      },
    });

    expect(codesOf(findings)).not.toContain("selectWithoutOptions");
  });
});

// ── Formula and condition references ─────────────────────

describe("template check: expression references", () => {
  test("flags a formula referencing an unknown path", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{rent}} {{total}}"],
      manifest: {
        ...emptyManifest,
        fields: [
          field("rent"),
          { path: "total", label: "Total", formula: "rent * bogus" },
        ],
      },
    });

    expect(findings).toContainEqual({
      code: "formulaUnknownPath",
      severity: "error",
      path: "total",
      reference: "bogus",
    });
  });

  test("functions and numeric literals are not flagged as references", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{rent}} {{total}}"],
      manifest: {
        ...emptyManifest,
        fields: [
          field("rent"),
          {
            path: "total",
            label: "Total",
            formula: "min(round(rent * 1.05, 2), 1_000)",
          },
        ],
      },
    });

    expect(codesOf(findings)).not.toContain("formulaUnknownPath");
  });

  test("flags a condition referencing a path that is neither a field nor a named condition", async () => {
    const findings = await checkDocument({
      paragraphs: ["{{entityType}}"],
      manifest: {
        ...emptyManifest,
        fields: [field("entityType")],
        conditions: [
          { name: "isCorp", expression: 'entityType == "corp"' },
          { name: "isBigCorp", expression: "isCorp and employees > 250" },
        ],
      },
    });

    expect(findings).toContainEqual({
      code: "conditionUnknownPath",
      severity: "error",
      conditionName: "isBigCorp",
      reference: "employees",
    });
    // isCorp resolves as a named condition, entityType as a field, and the
    // string literal "corp" is never treated as a reference.
    const conditionFindings = findings.filter(
      (f) => f.code === "conditionUnknownPath",
    );
    expect(conditionFindings).toHaveLength(1);
  });

  test("discovery-inferred condition drivers count as known paths", async () => {
    // hasGuarantor never appears as a {{marker}} but drives an #if block, so
    // discovery registers it as a boolean field.
    const findings = await checkDocument({
      paragraphs: ["{{#if hasGuarantor}}", "Guarantor: {{name}}", "{{/if}}"],
      manifest: {
        ...emptyManifest,
        fields: [field("name")],
        conditions: [{ name: "guaranteed", expression: "hasGuarantor" }],
      },
    });

    expect(codesOf(findings)).not.toContain("conditionUnknownPath");
  });
});

// ── Bounds and manifest round-trip ───────────────────────

describe("template check: bounds", () => {
  test("caps findings at MAX_CHECK_FINDINGS", async () => {
    const fields = Array.from({ length: MAX_CHECK_FINDINGS + 50 }, (_, i) => ({
      path: `ghost${i}`,
    }));
    const findings = await checkDocument({
      paragraphs: ["No markers"],
      manifest: { ...emptyManifest, fields },
    });

    expect(findings.length).toBe(MAX_CHECK_FINDINGS);
  });

  test("works against a manifest read back from a real DOCX", async () => {
    let buffer = await makeDocx(WRAP(P("Client: {{clientName}}")));
    buffer = await writeManifest(buffer, {
      version: 1,
      fields: [
        { path: "clientName", label: "Client Name", inputType: "text" },
        { path: "ghost", label: "Ghost", inputType: "text" },
      ],
      conditions: [],
    });

    const [discovered, manifest, clauseSlots] = await Promise.all([
      discoverTemplate(buffer),
      readManifest(buffer),
      discoverClauseSlots(buffer),
    ]);
    const findings = buildTemplateCheckFindings({
      discovered,
      manifest,
      clauseSlots,
      clauseLinks: [],
    });

    expect(findings).toEqual([
      { code: "unplacedField", severity: "warning", path: "ghost" },
    ]);
  });
});
