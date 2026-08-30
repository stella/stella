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
});
