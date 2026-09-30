import { describe, expect, test } from "bun:test";

import {
  reportExportBodySchema,
  reportExportConsumesServices,
} from "@/api/handlers/reports/views/export-input";
import { classifyValidatedCapabilityServiceInput } from "@/api/mcp/capability-tools";

const body = {
  templateRef: { type: "builtin", key: "due-diligence" },
  viewId: "11111111-1111-4111-8111-111111111111",
  mode: "download",
};

describe("capability classification uses validated export input", () => {
  test("raw exports bypass services across output formats", () => {
    for (const format of ["docx", "pdf"] as const) {
      for (const aiNarrative of [true, false, undefined]) {
        const result = classifyValidatedCapabilityServiceInput({
          config: {
            body: reportExportBodySchema,
            mcp: {
              type: "capability",
              consumesServices: reportExportConsumesServices,
            },
          },
          entry: { handlerKind: "workspace", transport: { type: "json" } },
          publicInput: {
            params: undefined,
            query: undefined,
            body: {
              ...body,
              format,
              ...(aiNarrative === undefined ? {} : { aiNarrative }),
            },
          },
        });
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value).toBe(aiNarrative !== false);
        }
      }
    }
  });

  test("invalid export input is refused before its classifier runs", () => {
    let classifications = 0;
    const result = classifyValidatedCapabilityServiceInput({
      config: {
        body: reportExportBodySchema,
        mcp: {
          type: "capability",
          consumesServices: () => {
            classifications += 1;
            return false;
          },
        },
      },
      entry: { handlerKind: "workspace", transport: { type: "json" } },
      publicInput: {
        params: undefined,
        query: undefined,
        body: { ...body, viewId: "invalid", aiNarrative: false },
      },
    });
    expect(result.isErr()).toBe(true);
    expect(classifications).toBe(0);
  });
});
