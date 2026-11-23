import { describe, expect, test } from "bun:test";

import { UNSCANNED_CONTENT_WARNING } from "@stll/api-contract/file-scan-warnings";

import { fieldUnscannedContent } from "./unscanned-content-notice";

const entity = {
  fields: [
    {
      id: "field-text",
      content: {
        type: "text",
        scanWarnings: [UNSCANNED_CONTENT_WARNING.encrypted],
      },
    },
    {
      id: "field-archive",
      content: {
        type: "file",
        scanWarnings: [
          "Embedded ELF (Linux) executable signature found",
          UNSCANNED_CONTENT_WARNING.encrypted,
        ],
      },
    },
    { id: "field-clean", content: { type: "file" } },
  ],
};

describe("fieldUnscannedContent", () => {
  test("reads the shown file field's stored warnings", () => {
    expect(fieldUnscannedContent(entity, "field-archive")).toEqual([
      "encrypted",
    ]);
  });

  test("is empty for a clean file, another kind of field or no entity", () => {
    expect(fieldUnscannedContent(entity, "field-clean")).toEqual([]);
    expect(fieldUnscannedContent(entity, "field-text")).toEqual([]);
    expect(fieldUnscannedContent(entity, "field-missing")).toEqual([]);
    expect(fieldUnscannedContent(undefined, "field-archive")).toEqual([]);
  });
});
