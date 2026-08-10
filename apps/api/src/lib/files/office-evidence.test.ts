import { describe, expect, test } from "bun:test";

import { resolveOfficeEvidenceFormat } from "@/api/lib/files/office-evidence";
import { OFFICE_EVIDENCE_FORMAT } from "@/api/lib/files/office-evidence-domain";
import { XLSX_MIME_TYPE } from "@/api/mime-types";

describe("Office evidence format resolution", () => {
  test("normalizes MIME casing and parameters", () => {
    expect(
      resolveOfficeEvidenceFormat(
        ` ${XLSX_MIME_TYPE.toUpperCase()}; charset=binary`,
      ),
    ).toBe(OFFICE_EVIDENCE_FORMAT.xlsx);
  });
});
