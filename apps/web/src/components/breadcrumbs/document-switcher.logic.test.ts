import { describe, expect, it } from "bun:test";

import { isCurrentDocument } from "@/components/breadcrumbs/document-switcher.logic";

describe("current document selection", () => {
  it("requires both entity and field identity", () => {
    const current = { entityId: "document", fieldId: "original" };
    for (const entityId of ["document", "other"]) {
      for (const fieldId of ["original", "attachment"]) {
        expect(isCurrentDocument({ entityId, fieldId }, current)).toBe(
          entityId === "document" && fieldId === "original",
        );
      }
    }
  });
});
