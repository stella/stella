import { describe, expect, test } from "bun:test";

import { reportExportConsumesServices } from "@/api/handlers/reports/views/export-input";

const viewId = "11111111-1111-4111-8111-111111111111";
const templateRefs = [
  { type: "builtin", key: "due-diligence" },
  { type: "stored", templateId: "22222222-2222-4222-8222-222222222222" },
] as const;

const classify = (body: unknown) =>
  reportExportConsumesServices({ body, params: {}, query: {} });

describe("report export service classification", () => {
  test("only an explicit disabled narrative bypasses services for every export target", () => {
    for (const templateRef of templateRefs) {
      for (const mode of ["workspace", "download"] as const) {
        for (const format of ["docx", "pdf", undefined] as const) {
          const body = {
            templateRef,
            viewId,
            mode,
            ...(format === undefined ? {} : { format }),
          };
          expect(classify(body)).toBe(true);
          expect(classify({ ...body, aiNarrative: true })).toBe(true);
          expect(classify({ ...body, aiNarrative: false })).toBe(false);
        }
      }
    }
  });

  test("malformed inputs cannot receive a data-only classification", () => {
    const body = {
      templateRef: { type: "builtin", key: "due-diligence" },
      viewId,
      mode: "download",
      aiNarrative: false,
    };
    const malformed = [
      undefined,
      null,
      {},
      { aiNarrative: false },
      { ...body, viewId: "invalid" },
      { ...body, mode: "invalid" },
      { ...body, format: "invalid" },
      { ...body, templateRef: { type: "stored", templateId: "invalid" } },
      { ...body, aiNarrative: "false" },
      { ...body, aiNarrative: 0 },
      { ...body, aiNarrative: null },
    ];
    for (const input of malformed) {
      expect(() => classify(input)).toThrow(
        "Report export classification requires validated input",
      );
    }
  });
});
