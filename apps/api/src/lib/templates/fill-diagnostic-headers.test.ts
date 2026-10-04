import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  CLAUSE_WARNINGS_HEADER,
  UNDECIDED_CONDITIONS_HEADER,
  undecidedConditionsHeaderSchema,
} from "@stll/api-contract/template-fill-headers";

import type { FillDiagnostics } from "@/api/lib/templates/template-fill-completion";

import { fillDiagnosticHeaders } from "./fill-diagnostic-headers";

const EMPTY_DIAGNOSTICS: FillDiagnostics = {
  unmatchedPlaceholders: [],
  aiFieldErrors: [],
  undecidedConditions: [],
  clauseWarnings: [],
  structureErrors: [],
  unusedValues: [],
  unrestoredFields: [],
};

describe("fillDiagnosticHeaders", () => {
  test("a complete fill carries no diagnostic header", () => {
    const headers = fillDiagnosticHeaders({
      diagnostics: EMPTY_DIAGNOSTICS,
      format: "docx",
    });
    expect([...headers.keys()]).toEqual([]);
  });

  test("undecided AI conditions travel in a header the web contract parses, on both formats", () => {
    const diagnostics: FillDiagnostics = {
      ...EMPTY_DIAGNOSTICS,
      undecidedConditions: [
        {
          path: "smlouva.spotřebitel",
          label: "Spotřebitelská smlouva — ano/ne",
          state: "undecided",
          reason: "no-backend",
        },
      ],
    };
    for (const format of ["docx", "pdf"] as const) {
      const headers = fillDiagnosticHeaders({ diagnostics, format });
      const raw = headers.get(UNDECIDED_CONDITIONS_HEADER);
      expect(raw).not.toBeNull();
      expect(
        v.parse(
          undecidedConditionsHeaderSchema,
          JSON.parse(decodeURIComponent(raw ?? "")),
        ),
      ).toEqual([
        {
          path: "smlouva.spotřebitel",
          label: "Spotřebitelská smlouva — ano/ne",
          reason: "no-backend",
        },
      ]);
    }
  });

  test("document-only diagnostics stay off a PDF download", () => {
    const diagnostics: FillDiagnostics = {
      ...EMPTY_DIAGNOSTICS,
      unmatchedPlaceholders: ["law"],
      unusedValues: ["extra"],
      structureErrors: [
        {
          message: "Unclosed — if",
          paragraphIndex: 0,
          directive: "{% if x %}",
        },
      ],
      clauseWarnings: [
        {
          code: "CLAUSE_LEGACY_DIRECTIVES",
          clauseName: "Terms",
          version: null,
          message: "Clause Terms retains literal legacy directive markers.",
          issues: [],
        },
      ],
    };
    const pdf = fillDiagnosticHeaders({ diagnostics, format: "pdf" });
    expect([...pdf.keys()]).toEqual([CLAUSE_WARNINGS_HEADER.toLowerCase()]);
    const docx = fillDiagnosticHeaders({ diagnostics, format: "docx" });
    expect(docx.get("X-Unmatched-Placeholders")).toBe("law");
    expect(docx.get("X-Unused-Values")).toBe("extra");
    expect(docx.get(CLAUSE_WARNINGS_HEADER)).toBe("1");
    expect(
      JSON.parse(decodeURIComponent(docx.get("X-Structure-Errors") ?? "")),
    ).toEqual(diagnostics.structureErrors);
  });
});
