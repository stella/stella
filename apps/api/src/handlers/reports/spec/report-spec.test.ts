import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  parseReportSpec,
  placeholderKeys,
  REPORT_SECTION_KINDS,
  ROOT_INTERPOLATION_KEYS,
} from "./report-spec";

const minimal = (sections: unknown[]): unknown => ({
  version: 1,
  name: "Spec",
  sections,
});

describe("parseReportSpec", () => {
  test("accepts every declared section kind", () => {
    const sections: { kind: string; [key: string]: unknown }[] = [
      { kind: "cover", title: "{{workspace.name}}", notice: "{{generatedAt}}" },
      { kind: "toc", levels: { from: 1, to: 3 } },
      { kind: "page-break" },
      { kind: "narrative", heading: "Summary", prompt: { text: "Write." } },
      { kind: "stats", by: "documentType" },
      { kind: "findings-table", columns: ["severity", "issue"], limit: 5 },
      {
        kind: "grouped",
        by: "documentType",
        order: "name",
        heading: "{{group.documentType}}",
        children: [
          { kind: "stats", by: "severity" },
          { kind: "findings", include: ["rationale"], citations: "endnote" },
        ],
      },
      { kind: "findings", include: [], citations: "none" },
      { kind: "per-contract" },
      { kind: "matrix", heading: "Matrix" },
      { kind: "appendix", heading: "Annex", children: [{ kind: "matrix" }] },
    ];
    const parsed = parseReportSpec(minimal(sections));
    expect(Result.isOk(parsed)).toBe(true);
    // Both directions: every kind the schema declares is exercised above.
    expect(new Set(sections.map((section) => section.kind))).toEqual(
      new Set(REPORT_SECTION_KINDS),
    );
  });

  test("rejects an unknown section kind", () => {
    const parsed = parseReportSpec(
      minimal([{ kind: "chart", by: "severity" }]),
    );
    expect(Result.isError(parsed)).toBe(true);
  });

  test("rejects unknown keys on a section", () => {
    const parsed = parseReportSpec(minimal([{ kind: "page-break", after: 1 }]));
    expect(Result.isError(parsed)).toBe(true);
  });

  test("rejects an interpolation key outside the allowlist", () => {
    expect(placeholderKeys("A {{ workspace.name }} {{nope}}")).toEqual([
      "workspace.name",
      "nope",
    ]);
    expect(ROOT_INTERPOLATION_KEYS).not.toContain("nope");
    const parsed = parseReportSpec(
      minimal([{ kind: "cover", title: "Report for {{nope}}" }]),
    );
    expect(Result.isError(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      expect(parsed.error.message).toContain("Unknown placeholder");
    }
  });

  test("rejects a group-only placeholder at root and documentType stats in a group", () => {
    expect(
      Result.isError(
        parseReportSpec(
          minimal([{ kind: "cover", title: "{{group.documentType}}" }]),
        ),
      ),
    ).toBe(true);
    expect(
      Result.isError(
        parseReportSpec(
          minimal([
            {
              kind: "grouped",
              by: "documentType",
              order: "name",
              heading: "G",
              children: [{ kind: "stats", by: "documentType" }],
            },
          ]),
        ),
      ),
    ).toBe(true);
  });

  test("rejects reversed or out-of-range TOC levels", () => {
    const parse = (levels: unknown) =>
      parseReportSpec(minimal([{ kind: "toc", levels }]));
    expect(Result.isOk(parse({ from: 2, to: 3 }))).toBe(true);
    expect(Result.isOk(parse({ from: 1, to: 1 }))).toBe(true);
    const reversed = parse({ from: 3, to: 1 });
    expect(Result.isError(reversed)).toBe(true);
    if (Result.isError(reversed)) {
      expect(reversed.error.message).toContain("from <= to");
    }
    expect(Result.isError(parse({ from: 1, to: 4 }))).toBe(true);
    expect(Result.isError(parse({ from: 0, to: 2 }))).toBe(true);
  });

  test("rejects a nested appendix", () => {
    const parsed = parseReportSpec(
      minimal([
        {
          kind: "appendix",
          heading: "A",
          children: [{ kind: "appendix", heading: "B", children: [] }],
        },
      ]),
    );
    expect(Result.isError(parsed)).toBe(true);
  });
});
