import { describe, expect, test } from "bun:test";

import { buildSavedEmailUrl } from "@/lib/saved-email-url";

describe("buildSavedEmailUrl", () => {
  test("targets the existing document route and exact saved file field", () => {
    expect(
      buildSavedEmailUrl({
        baseUrl: "https://app.stll.example",
        entityId: "message-id",
        fieldId: "file-field-id",
        workspaceId: "matter-id",
      }),
    ).toBe(
      "https://app.stll.example/workspaces/matter-id/all/document?entity=message-id&field=file-field-id",
    );
  });

  test("falls back to the matter when the file field is unknown", () => {
    expect(
      buildSavedEmailUrl({
        baseUrl: "https://app.stll.example",
        entityId: "message-id",
        fieldId: null,
        workspaceId: "matter-id",
      }),
    ).toBe("https://app.stll.example/workspaces/matter-id");
  });
});
